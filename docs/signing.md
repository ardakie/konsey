# Windows code signing (SignPath Foundation)

Konsey's Windows builds are unsigned until SignPath Foundation approves the project.
Windows 11 **Smart App Control** blocks unsigned programs outright, so signing is
what makes the Windows download usable for everyone.

The release workflow (`.github/workflows/release.yml`) already contains the signing
steps. They stay inactive until the settings below exist, and the normal unsigned
build keeps working in the meantime.

## 1. Apply

Apply at <https://signpath.org/apply>. Requirements that this repository already meets:

- OSI license (MIT), no proprietary components, released builds, documented functionality.
- "Code signing policy" section with team roles and the required attribution (README).
- Privacy policy statement (README → Privacy policy).
- Uninstall instructions (README → Uninstall).
- Builds come from GitHub Actions, from tagged commits.

Before applying, turn on two-factor authentication for GitHub (and later for SignPath).

## 2. Configure SignPath (after approval)

In SignPath.io create a project with the slug **`konsey`**, link it to the GitHub
repository `ardakie/konsey` as a trusted build system, and add a signing policy with
the slug **`release-signing`** (manual approval, SignPath Foundation certificate).

Add two artifact configurations:

**`app`** — the unpacked application (zip of `release/win-unpacked`):

```xml
<?xml version="1.0" encoding="utf-8"?>
<artifact-configuration xmlns="http://signpath.io/artifact-configuration/v1">
  <zip-file>
    <pe-file path="Konsey.exe" product-name="Konsey">
      <authenticode-sign />
    </pe-file>
  </zip-file>
</artifact-configuration>
```

**`installer`** — the NSIS installer:

```xml
<?xml version="1.0" encoding="utf-8"?>
<artifact-configuration xmlns="http://signpath.io/artifact-configuration/v1">
  <zip-file>
    <pe-file path="Konsey-windows-x64-setup.exe" product-name="Konsey">
      <authenticode-sign />
    </pe-file>
  </zip-file>
</artifact-configuration>
```

## 3. Connect GitHub

In the GitHub repository settings:

- **Variables → Actions:** `SIGNPATH_ORGANIZATION_ID` = your SignPath organization id.
- **Secrets → Actions:** `SIGNPATH_API_TOKEN` = an API token of a SignPath CI user
  with submitter permission on the `konsey` project.

The next `vX.Y.Z` tag then builds the app, sends it to SignPath, waits for your
approval in SignPath, builds the installer from the signed app, signs the installer
and uploads it to the release.

---

**Türkçe özet:** SignPath onay verince (1) SignPath'te `konsey` projesini, `release-signing`
politikasını ve yukarıdaki `app` ile `installer` ayarlarını oluştur, (2) GitHub deposuna
`SIGNPATH_ORGANIZATION_ID` değişkenini ve `SIGNPATH_API_TOKEN` gizli değerini ekle.
Sonraki sürüm etiketi Windows sürümünü imzalı yayınlar; her imzalamayı SignPath'te sen onaylarsın.
