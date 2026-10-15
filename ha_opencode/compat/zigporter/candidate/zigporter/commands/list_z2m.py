import asyncio
import json

from rich.console import Console
from rich.progress import Progress, SpinnerColumn, TextColumn
from rich.table import Table

from zigporter.z2m_client import Z2MClient

console = Console()


async def run_list_z2m(
    ha_url: str,
    token: str,
    z2m_url: str,
    verify_ssl: bool,
    mqtt_topic: str = "zigbee2mqtt",
    json_output: bool = False,
) -> None:
    client = Z2MClient(ha_url, token, z2m_url, verify_ssl, mqtt_topic)

    if json_output:
        devices = await client.get_devices()
    else:
        with Progress(
            SpinnerColumn(), TextColumn("{task.description}"), console=console
        ) as progress:
            t = progress.add_task("Fetching Zigbee2MQTT devices...", total=None)
            devices = await client.get_devices()
            progress.update(t, description="Done")

    # Exclude the coordinator
    devices = [d for d in devices if d.get("type") != "Coordinator"]

    if json_output:
        result = []
        for d in sorted(devices, key=lambda x: x.get("friendly_name", "").lower()):
            definition = d.get("definition") or {}
            ieee = d.get("ieee_address") or ""
            result.append(
                {
                    "friendly_name": d.get("friendly_name") or ieee,
                    "ieee_address": ieee,
                    "type": d.get("type") or "",
                    "vendor": definition.get("vendor") or d.get("manufacturer") or "",
                    "model": definition.get("model") or d.get("model_id") or "",
                    "power_source": d.get("power_source") or "",
                    "supported": d.get("supported"),
                    "diagnostics": d.get("_diagnostics", {}),
                }
            )
        print(json.dumps({"devices": result, "warning": client.last_device_read_warning}, indent=2))
        return

    if client.last_device_read_warning:
        console.print(client.last_device_read_warning)
    console.print("Readings may be cached; device report freshness is not established.")

    table = Table(title=f"Zigbee2MQTT Devices ({len(devices)})", show_header=True)
    table.add_column("Friendly name", no_wrap=True)
    table.add_column("IEEE address")
    table.add_column("Type")
    table.add_column("Vendor")
    table.add_column("Model")
    table.add_column("Power source")

    for d in sorted(devices, key=lambda x: x.get("friendly_name", "").lower()):
        definition = d.get("definition") or {}
        vendor = definition.get("vendor") or d.get("manufacturer") or ""
        model = definition.get("model") or d.get("model_id") or ""
        power = d.get("power_source") or ""
        dev_type = d.get("type") or ""
        ieee = d.get("ieee_address") or ""
        name = d.get("friendly_name") or ieee

        supported = d.get("supported", True)
        style = "" if supported else "dim"

        table.add_row(name, ieee, dev_type, vendor, model, power, style=style)

    console.print(table)


def list_z2m_command(
    ha_url: str,
    token: str,
    z2m_url: str,
    verify_ssl: bool,
    mqtt_topic: str = "zigbee2mqtt",
    json_output: bool = False,
) -> None:
    asyncio.run(run_list_z2m(ha_url, token, z2m_url, verify_ssl, mqtt_topic, json_output))
