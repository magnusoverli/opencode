import asyncio
import json
import io
import os
import ssl
import tempfile
import subprocess
import importlib.util
from contextlib import redirect_stdout
import sys
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch
sys.path.insert(0, os.environ.get('ZIGPORTER_TEST_PACKAGE', str(Path(__file__).parent/'candidate')))
from zigporter.z2m_client import Z2MClient
from zigporter.passive_z2m import read_devices, websocket_url, PassiveReadError
from websockets.asyncio.server import serve

IEEE = '0x0011223344556677'
PAIR = ['mqtt', 'zigbee2mqtt_' + IEEE]
DEVICE = {'ieee_address': IEEE, 'friendly_name': 'test PIR', 'type': 'EndDevice'}

class RegistryTests(unittest.IsolatedAsyncioTestCase):
    async def registry(self, records):
        client = Z2MClient('http://ha.invalid', 'synthetic', 'http://z2m.invalid')
        client._ha_client_instance = type('FakeHA', (), {'get_device_registry': AsyncMock(return_value=records)})()
        return await client._get_devices_via_ha()

    async def test_original_published_code_reproduces_crash(self):
        path = Path(__file__).parent/'upstream/zigporter/z2m_client.py'
        spec=importlib.util.spec_from_file_location('original_z2m',path)
        original=importlib.util.module_from_spec(spec)
        spec.loader.exec_module(original)
        client=original.Z2MClient('http://ha.invalid','synthetic','http://z2m.invalid')
        client._ha_client_instance=type('FakeHA',(),{'get_device_registry':AsyncMock(return_value=[
            {'identifiers':[['homekit','redacted','redacted'],PAIR]}])})()
        with self.assertRaises(ValueError):
            await client._get_devices_via_ha()

    async def test_direct_read_does_not_call_fallback(self):
        client=Z2MClient('http://ha.invalid','synthetic','http://z2m.invalid')
        client._get_devices_via_ha=AsyncMock(side_effect=AssertionError('Unexpected fallback'))
        with patch('zigporter.passive_z2m.read_devices',AsyncMock(return_value=[DEVICE])):
            self.assertEqual(await client.get_devices(),[DEVICE])
        client._get_devices_via_ha.assert_not_called()
        self.assertIsNone(client.last_device_read_warning)

    async def test_homekit_triple_before_valid_mqtt(self):
        devices = await self.registry([{'identifiers': [['homekit','redacted','redacted'], PAIR]}])
        self.assertEqual(devices[0]['ieee_address'], IEEE)
        self.assertEqual(devices[0]['_diagnostics']['source'], 'ha_device_registry')
        self.assertIsNone(devices[0]['type'])
        self.assertIsNone(devices[0]['supported'])

    async def test_malformed_shapes_and_duplicate(self):
        for identifiers in (None, {}, 'mqtt', [None, 2, {}, [], ['mqtt'], ['mqtt','x','extra']], [['mqtt',None]], [['mqtt','invalid']], [['mqtt', IEEE]]):
            with self.subTest(identifiers=identifiers):
                self.assertEqual(await self.registry([{'identifiers':identifiers}]), [])
        self.assertEqual(len(await self.registry([None, {}, {'identifiers':[PAIR]}, {'identifiers':[PAIR]}])), 1)

    async def test_invalid_registry_container_fails_cleanly(self):
        with self.assertRaisesRegex(RuntimeError, 'Invalid HA'):
            await self.registry({'unexpected':'shape'})

    async def test_transport_failure_falls_back_with_provenance(self):
        client = Z2MClient('http://ha.invalid','synthetic','http://z2m.invalid')
        client._get_devices_via_ha = AsyncMock(return_value=[{'_diagnostics':{'source':'ha_device_registry'}}])
        client._get = AsyncMock(side_effect=AssertionError('No legacy REST/auth escalation'))
        with patch('zigporter.passive_z2m.read_devices', side_effect=PassiveReadError('unavailable')):
            result = await client.get_devices()
        self.assertEqual(result[0]['_diagnostics']['source'], 'ha_device_registry')
        self.assertIn('inventory only',client.last_device_read_warning)
        client._get.assert_not_called()

    async def test_standalone_failure_not_hidden(self):
        client = Z2MClient(None,None,'http://z2m.invalid')
        with patch('zigporter.passive_z2m.read_devices', side_effect=PassiveReadError('unavailable')):
            with self.assertRaises(PassiveReadError):
                await client.get_devices()

class OutputTests(unittest.IsolatedAsyncioTestCase):
    async def test_json_keeps_provenance_unknowns_and_warning(self):
        from zigporter.commands.list_z2m import run_list_z2m
        fake = type('Fake', (), {})()
        fake.last_device_read_warning = 'HA registry inventory only'
        fake.get_devices = AsyncMock(return_value=[dict(DEVICE, supported=None,
            _diagnostics={'source':'ha_device_registry','last_seen':None})])
        output=io.StringIO()
        with patch('zigporter.commands.list_z2m.Z2MClient',return_value=fake), redirect_stdout(output):
            await run_list_z2m('unused','synthetic','unused',True,json_output=True)
        result=json.loads(output.getvalue())
        self.assertEqual(result['devices'][0]['diagnostics']['source'],'ha_device_registry')
        self.assertIsNone(result['devices'][0]['supported'])
        self.assertIn('inventory only',result['warning'])

class TransportTests(unittest.IsolatedAsyncioTestCase):
    async def fixture(self, frames, *, expected_error=None, limit=4096):
        received = []
        async def handler(ws):
            for frame in frames:
                await ws.send(frame if isinstance(frame, (bytes,str)) else json.dumps(frame))
            try:
                async for message in ws:
                    received.append(message)
            except Exception:
                pass
        async with serve(handler,'127.0.0.1',0) as server:
            port = server.sockets[0].getsockname()[1]
            call = read_devices(f'http://127.0.0.1:{port}',duration=.08,max_frames=limit)
            if expected_error:
                with self.assertRaises(expected_error):
                    await call
                result = None
            else:
                result = await call
        self.assertEqual(received, [], 'Reader must send zero application messages')
        return result

    async def test_cached_inventory_and_telemetry(self):
        result = await self.fixture([
            {'topic':'test PIR','payload':{'linkquality':149,'last_seen':'2026-10-14T10:00:00Z','occupancy':True}},
            {'topic':'test PIR/availability','payload':{'state':'offline'}},
            {'topic':'bridge/info','payload':{'secret':'MUST NOT RETURN'}},
            {'topic':'bridge/devices','payload':[DEVICE]}])
        diag = result[0]['_diagnostics']
        self.assertEqual(diag['linkquality'],149)
        self.assertEqual(diag['availability'],'offline')
        self.assertEqual(diag['last_seen'],'2026-10-14T10:00:00Z')
        self.assertIn('does not prove',diag['freshness'])
        self.assertIsNone(diag['parent'])
        self.assertNotIn('MUST NOT RETURN',str(result))

    async def test_invalid_telemetry_and_duplicate_inventory(self):
        result = await self.fixture([
            {'topic':'bridge/devices','payload':[DEVICE, DEVICE, {'ieee_address':'bad'}]},
            {'topic':'test PIR','payload':{'linkquality':999,'last_seen':{'bad':'shape'}}},
            {'topic':'test PIR/availability','payload':'invalid'}])
        self.assertEqual(len(result),1)
        for key in ('linkquality','last_seen','availability'):
            self.assertIsNone(result[0]['_diagnostics'][key])

    async def test_empty_inventory_is_success(self):
        self.assertEqual(await self.fixture([{'topic':'bridge/devices','payload':[]}]), [])

    async def test_missing_fields_remain_unknown(self):
        result = await self.fixture([{'topic':'bridge/devices','payload':[DEVICE]}])
        for key in ('last_seen','linkquality','availability','parent','routes'):
            self.assertIsNone(result[0]['_diagnostics'][key])

    async def test_malformed_frames_ignored(self):
        result = await self.fixture(['bad json', '[]', b'binary', {'topic':'bridge/devices','payload':{}},
                                    {'topic':'bridge/devices','payload':[None,{},DEVICE]}])
        self.assertEqual(len(result),1)

    async def test_timeout_without_inventory(self):
        await self.fixture([], expected_error=PassiveReadError)

    async def test_frame_flood_fails_closed(self):
        await self.fixture([{'topic':'bridge/devices','payload':[]}]*3, expected_error=PassiveReadError,limit=2)

    async def test_auth_close_redacts_token(self):
        async def reject(ws):
            await ws.close(4401,'Unauthorized SECRET')
        async with serve(reject,'127.0.0.1',0) as server:
            port=server.sockets[0].getsockname()[1]
            with self.assertRaises(PassiveReadError) as caught:
                await read_devices(f'http://127.0.0.1:{port}',token='SECRET',duration=.1)
        self.assertNotIn('SECRET',str(caught.exception))

    async def test_cancel_releases_connection(self):
        closed = asyncio.Event()
        async def handler(ws):
            await ws.wait_closed()
            closed.set()
        async with serve(handler,'127.0.0.1',0) as server:
            port=server.sockets[0].getsockname()[1]
            task=asyncio.create_task(read_devices(f'http://127.0.0.1:{port}',duration=10))
            await asyncio.sleep(.03)
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
            await asyncio.wait_for(closed.wait(),.5)

    def test_url_and_token_encoding(self):
        self.assertEqual(websocket_url('https://example.invalid/z2m/','a&b'), 'wss://example.invalid/z2m/api?token=a%26b')
        for url in ('ftp://x','http://user:pass@x','http://x?token=secret','http://x#f'):
            with self.subTest(url=url), self.assertRaises(ValueError):
                websocket_url(url)

    async def test_managed_false_setting_through_actual_list_command(self):
        from zigporter.commands.list_z2m import run_list_z2m
        received=[]
        async def handler(ws):
            await ws.send(json.dumps({'topic':'bridge/devices','payload':[DEVICE]}))
            try:
                async for msg in ws:
                    received.append(msg)
            except Exception:
                pass
        async with serve(handler,'127.0.0.1',0) as server:
            port=server.sockets[0].getsockname()[1]
            output=io.StringIO()
            with redirect_stdout(output):
                await run_list_z2m('http://ha.invalid','synthetic',f'http://127.0.0.1:{port}',False,json_output=True)
        result=json.loads(output.getvalue())
        self.assertEqual(result['devices'][0]['diagnostics']['source'],'z2m_frontend_websocket')
        self.assertIsNone(result['warning'])
        self.assertEqual(received,[])

    async def test_ha_false_still_requires_valid_wss_certificate(self):
        # Ephemeral self-signed loopback certificate, never a real credential.
        with tempfile.TemporaryDirectory() as directory:
            cert=Path(directory)/'cert.pem'
            key=Path(directory)/'key.pem'
            subprocess.run(['openssl','req','-x509','-newkey','rsa:2048','-nodes',
                            '-keyout',str(key),'-out',str(cert),'-days','1',
                            '-subj','/CN=localhost'],check=True,capture_output=True)
            context=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            context.load_cert_chain(cert,key)
            async def handler(ws):
                await ws.send(json.dumps({'topic':'bridge/devices','payload':[DEVICE]}))
                await ws.wait_closed()
            async with serve(handler,'127.0.0.1',0,ssl=context) as server:
                port=server.sockets[0].getsockname()[1]
                client=Z2MClient(None,None,f'https://127.0.0.1:{port}',verify_ssl=False)
                with self.assertRaises(PassiveReadError):
                    await client.get_devices()

    async def test_wss_explicit_verified_context_independent_of_ha_flag(self):
        class Context:
            async def __aenter__(self):
                raise OSError('synthetic endpoint failure')
            async def __aexit__(self,*args):
                pass
        with patch('zigporter.passive_z2m.websockets.connect',return_value=Context()) as connect:
            client=Z2MClient(None,None,'https://z2m.invalid',verify_ssl=False)
            with self.assertRaises(PassiveReadError):
                await client.get_devices()
        context=connect.call_args.kwargs['ssl']
        self.assertTrue(context.check_hostname)
        self.assertEqual(context.verify_mode,ssl.CERT_REQUIRED)

if __name__ == '__main__':
    unittest.main(verbosity=2)
