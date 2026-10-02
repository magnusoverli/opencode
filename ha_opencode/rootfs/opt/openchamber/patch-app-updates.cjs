// Patch only the pinned preview's informational OpenCode notice, before building
// the frontend. Supervisor owns component updates; this adds no update machinery.
const fs = require("node:fs");
const path = require("node:path");

const key = "opencodeUpdate.toast.available.manualDescription";
// Exact upstream values make drift visible when changing the preview revision.
// Every locale overrides this key, so an English-only patch is insufficient.
const messages = { nl: ["", "Versie {version} beschikbaar. Werk OpenCode bij op de manier waarop u het hebt geïnstalleerd en herstart daarna OpenChamber.", "OpenCode {version} is beschikbaar vanuit de bron. Home Assistant Supervisor beheert de OpenCode- en OpenChamber-versies van deze applicatie. Controleer op updates op de pagina van de applicatie in Home Assistant; deze release betekent niet dat een update beschikbaar is."],
  en: [
    "Version {version} available. Update OpenCode the way you installed it, then restart OpenChamber.",
    "OpenCode {version} is available upstream. Home Assistant Supervisor manages this app's OpenCode and OpenChamber versions. Check the app's page in Home Assistant for updates; this upstream release does not mean an app update is available.",
  ],
  de: [
    "Version {version} verfügbar. Aktualisieren Sie OpenCode so, wie Sie es installiert haben, und starten Sie OpenChamber dann neu.",
    "OpenCode {version} ist beim Upstream-Projekt verfügbar. Home Assistant Supervisor verwaltet die OpenCode- und OpenChamber-Versionen dieser App. Prüfen Sie die App-Seite in Home Assistant auf Updates; diese Upstream-Version bedeutet nicht, dass ein App-Update verfügbar ist.",
  ],
  fr: [
    "Version {version} disponible. Mettez à jour OpenCode comme vous l’avez installé, puis redémarrez OpenChamber.",
    "OpenCode {version} est disponible en amont. Home Assistant Supervisor gère les versions d’OpenCode et d’OpenChamber de cette application. Consultez la page de l’application dans Home Assistant pour les mises à jour ; cette version amont ne signifie pas qu’une mise à jour de l’application est disponible.",
  ],
  "zh-CN": [
    "版本 {version} 可用。请按安装时的方式更新 OpenCode，然后重启 OpenChamber。",
    "OpenCode 上游已发布 {version}。本应用的 OpenCode 和 OpenChamber 版本由 Home Assistant Supervisor 管理。请在 Home Assistant 的应用页面查看更新；上游发布新版本并不代表本应用已有可用更新。",
  ],
  "zh-TW": [
    "版本 {version} 可安裝。請以安裝時的方式更新 OpenCode，然後重新啟動 OpenChamber。",
    "OpenCode 上游已發布 {version}。本應用程式的 OpenCode 和 OpenChamber 版本由 Home Assistant Supervisor 管理。請在 Home Assistant 的應用程式頁面查看更新；上游發布新版本並不代表本應用程式已有可用更新。",
  ],
  uk: [
    "Доступна версія {version}. Оновіть OpenCode так само, як установлювали, і перезапустіть OpenChamber.",
    "Розробники OpenCode випустили версію {version}. Home Assistant Supervisor керує версіями OpenCode та OpenChamber у цьому застосунку. Перевірте оновлення на сторінці застосунку в Home Assistant; цей випуск OpenCode не означає, що оновлення застосунку вже доступне.",
  ],
  es: [
    "Versión {version} disponible. Actualiza OpenCode de la misma forma en que lo instalaste y luego reinicia OpenChamber.",
    "El proyecto OpenCode ha publicado la versión {version}. Home Assistant Supervisor gestiona las versiones de OpenCode y OpenChamber de esta aplicación. Consulta las actualizaciones en la página de la aplicación en Home Assistant; esta versión de OpenCode no implica que haya una actualización de la aplicación disponible.",
  ],
  "pt-BR": [
    "Versão {version} disponível. Atualize o OpenCode da mesma forma que o instalou e depois reinicie o OpenChamber.",
    "O projeto OpenCode publicou a versão {version}. O Home Assistant Supervisor gerencia as versões do OpenCode e do OpenChamber deste aplicativo. Confira as atualizações na página do aplicativo no Home Assistant; esta versão do OpenCode não significa que uma atualização do aplicativo esteja disponível.",
  ],
  ko: [
    "버전 {version} 사용 가능. 설치했던 방식으로 OpenCode를 업데이트한 뒤 OpenChamber를 다시 시작하세요.",
    "OpenCode 원본 프로젝트에서 {version} 버전을 출시했습니다. Home Assistant Supervisor가 이 앱의 OpenCode 및 OpenChamber 버전을 관리합니다. Home Assistant의 앱 페이지에서 업데이트를 확인하세요. 원본 프로젝트의 새 버전이 앱 업데이트가 제공된다는 뜻은 아닙니다.",
  ],
  pl: [
    "Wersja {version} dostępna. Zaktualizuj OpenCode w ten sam sposób, w jaki go zainstalowano, a następnie uruchom ponownie OpenChamber.",
    "Projekt OpenCode udostępnił wersję {version}. Home Assistant Supervisor zarządza wersjami OpenCode i OpenChamber w tej aplikacji. Sprawdź aktualizacje na stronie aplikacji w Home Assistant; nowe wydanie OpenCode nie oznacza, że aktualizacja aplikacji jest dostępna.",
  ],
  ja: [
    "バージョン{version}が利用可能です。インストール時と同じ方法で OpenCode を更新し、OpenChamber を再起動してください。",
    "OpenCode の開発元が {version} を公開しました。このアプリの OpenCode と OpenChamber のバージョンは Home Assistant Supervisor が管理します。Home Assistant のアプリページで更新を確認してください。開発元の新しいリリースは、アプリの更新が利用可能であることを意味しません。",
  ],
  tr: [
    "{version} sürümü mevcut. OpenCode’u kurduğunuz yöntemle güncelleyin, ardından OpenChamber’ı yeniden başlatın.",
    "OpenCode projesi {version} sürümünü yayımladı. Bu uygulamanın OpenCode ve OpenChamber sürümlerini Home Assistant Supervisor yönetir. Güncellemeler için Home Assistant içindeki uygulama sayfasını kontrol edin; bu OpenCode sürümü, bir uygulama güncellemesinin mevcut olduğu anlamına gelmez.",
  ],
  nl: [
    "Versie {version} beschikbaar. Werk OpenCode bij op de manier waarop u het hebt geïnstalleerd en herstart daarna OpenChamber.",
    "OpenCode heeft versie {version} uitgebracht. Home Assistant Supervisor beheert de OpenCode- en OpenChamber-versies van deze app. Controleer de app-pagina in Home Assistant op updates; deze nieuwe versie betekent niet dat er een app-update beschikbaar is.",
  ],
};

function patchAppUpdates(root) {
  const directory = path.join(root, "packages/ui/src/lib/i18n/messages");
  const pattern = new RegExp(`^([ \\t]*)(['"])${key.replaceAll(".", "\\.")}\\2: ([^\\r\\n]+?)(\\r?)$`, "gm");
  const quotedKey = new RegExp(`(['"])${key.replaceAll(".", "\\.")}\\1`, "g");
  const pending = [];
  for (const file of fs.readdirSync(directory).filter((name) => name.endsWith(".ts"))) {
    const locale = file.slice(0, -3);
    const target = path.join(directory, file);
    const source = fs.readFileSync(target, "utf8");
    if (!Object.hasOwn(messages, locale)) {
      if (source.includes(key)) throw new Error(`Unreviewed update-notice locale: ${locale}`);
      continue;
    }
    const matches = [...source.matchAll(pattern)];
    const [before, after] = messages[locale];
    if ([...source.matchAll(quotedKey)].length !== 1 || matches.length !== 1 ||
        ![`'${before}',`, `${JSON.stringify(before)},`].includes(matches[0][3])) {
      throw new Error(`Unexpected preview update notice: ${locale}`);
    }
    const match = matches[0];
    const replacement = `${match[1]}${match[2]}${key}${match[2]}: ${JSON.stringify(after)},${match[4]}`;
    pending.push([target, source.slice(0, match.index) + replacement + source.slice(match.index + match[0].length)]);
  }
  if (pending.length !== Object.keys(messages).length) throw new Error("Missing preview update-notice locale");
  // Validate all anchors before modifying any file; source drift must fail builds.
  for (const [target, contents] of pending) fs.writeFileSync(target, contents);
  return pending.length;
}

module.exports = { key, messages, patchAppUpdates };
if (require.main === module) {
  if (!process.argv[2]) throw new Error("Usage: patch-app-updates.cjs <preview-source-root>");
  console.log(`Patched ${patchAppUpdates(process.argv[2])} OpenCode update-notice locales for Home Assistant`);
}
