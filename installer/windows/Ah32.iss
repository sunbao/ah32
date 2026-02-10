; Ah32 Windows installer (Inno Setup)
;
; Build prerequisites:
; - Run `scripts\\package.ps1` first to generate `dist\\Ah32\\`
; - Install Inno Setup and ensure `ISCC.exe` is available
;
; Output:
; - `installer\\out\\Ah32Setup.exe`

#define MyAppName "Ah32"
#define MyAppVersion "0.1.0"
#define MyAppPublisher "Ah32 Team"
#define MyAppURL "https://ah32.com"

[Setup]
AppId={{8E8E1A9E-8E3B-4AAE-9D58-2E7E6D0E6E3E}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}
AppUpdatesURL={#MyAppURL}
DefaultDirName={localappdata}\{#MyAppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir=..\out
OutputBaseFilename=Ah32Setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern

[Languages]
Name: "en"; MessagesFile: "compiler:Default.isl"
Name: "zhcn"; MessagesFile: "compiler:Languages\ChineseSimplified.isl"

[Tasks]
Name: "startup"; Description: "Start {#MyAppName} at user login"; Flags: unchecked

[Files]
Source: "..\..\dist\Ah32\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
; User-facing templates (rules + sample skills) copied into Documents so office users can edit them in WPS.
Source: "..\assets\user-docs\*"; DestDir: "{userdocs}\Ah32"; Flags: ignoreversion recursesubdirs createallsubdirs onlyifdoesntexist

[Icons]
Name: "{userprograms}\{#MyAppName}\{#MyAppName}"; Filename: "{app}\{#MyAppName}.exe"
Name: "{userprograms}\{#MyAppName}\Uninstall {#MyAppName}"; Filename: "{uninstallexe}"
Name: "{userprograms}\{#MyAppName}\Edit .env"; Filename: "notepad.exe"; Parameters: """{app}\.env"""
Name: "{userprograms}\{#MyAppName}\Install WPS add-in"; Filename: "powershell.exe"; Parameters: "-ExecutionPolicy Bypass -File ""{app}\install-wps-plugin.ps1"" -AddinId Ah32 -PluginSource ""{app}\wps-plugin"" -AppRoot ""{app}"" -ApiBase ""http://127.0.0.1:5123"" -ApiKey """""
Name: "{userprograms}\{#MyAppName}\Uninstall WPS add-in"; Filename: "powershell.exe"; Parameters: "-ExecutionPolicy Bypass -File ""{app}\uninstall-wps-plugin.ps1"" -AddinId Ah32"

; Startup shortcut (per-user)
Name: "{userstartup}\{#MyAppName}"; Filename: "{app}\{#MyAppName}.exe"; Tasks: startup

[Run]
; Provision .env (fixed port 5123; auth disabled; set DeepSeek key if provided)
Filename: "powershell.exe"; Parameters: "-ExecutionPolicy Bypass -File ""{app}\setup-env.ps1"" -AppRoot ""{app}"" -DeepseekApiKey ""{code:GetDeepseekKey}"""; Flags: runhidden

; Install the WPS add-in (mandatory)
Filename: "powershell.exe"; Parameters: "-ExecutionPolicy Bypass -File ""{app}\install-wps-plugin.ps1"" -AddinId Ah32 -PluginSource ""{app}\wps-plugin"" -AppRoot ""{app}"" -ApiBase ""http://127.0.0.1:5123"" -ApiKey """""; Flags: runhidden

; Start backend after install
Filename: "{app}\{#MyAppName}.exe"; WorkingDir: "{app}"; Description: "Start {#MyAppName}"; Flags: nowait postinstall skipifsilent; Check: ShouldStartBackend

; If DeepSeek key is missing, open .env for user to fill
Filename: "notepad.exe"; Parameters: """{app}\.env"""; Flags: nowait postinstall skipifsilent; Check: ShouldOpenEnv

; Auto-open WPS after install
Filename: "{code:GetWpsExe}"; Flags: nowait postinstall skipifsilent; Check: ShouldOpenWps

[UninstallRun]
; Best-effort cleanup of WPS add-in
Filename: "powershell.exe"; Parameters: "-ExecutionPolicy Bypass -File ""{app}\uninstall-wps-plugin.ps1"" -AddinId Ah32"; Flags: runhidden

[Code]
var
  DeepseekPage: TInputQueryWizardPage;
  WpsExePath: string;

function Trimmed(const S: string): string;
begin
  Result := Trim(S);
end;

function FindWpsExe(var Exe: string): Boolean;
var
  Candidate: string;
  Root: string;
begin
  Result := False;
  Exe := '';

  ; Registry hints (best-effort, may vary by WPS version)
  if RegQueryStringValue(HKLM, 'SOFTWARE\Kingsoft\Office\6.0\Common', 'InstallRoot', Root) then begin
    Candidate := AddBackslash(Root) + 'ksolaunch.exe';
    if FileExists(Candidate) then begin Exe := Candidate; Result := True; exit; end;
    Candidate := AddBackslash(Root) + 'wps.exe';
    if FileExists(Candidate) then begin Exe := Candidate; Result := True; exit; end;
  end;
  if RegQueryStringValue(HKLM, 'SOFTWARE\WOW6432Node\Kingsoft\Office\6.0\Common', 'InstallRoot', Root) then begin
    Candidate := AddBackslash(Root) + 'ksolaunch.exe';
    if FileExists(Candidate) then begin Exe := Candidate; Result := True; exit; end;
    Candidate := AddBackslash(Root) + 'wps.exe';
    if FileExists(Candidate) then begin Exe := Candidate; Result := True; exit; end;
  end;

  ; Common install locations
  Candidate := ExpandConstant('{pf}\Kingsoft\WPS Office\ksolaunch.exe');
  if FileExists(Candidate) then begin Exe := Candidate; Result := True; exit; end;
  Candidate := ExpandConstant('{pf32}\Kingsoft\WPS Office\ksolaunch.exe');
  if FileExists(Candidate) then begin Exe := Candidate; Result := True; exit; end;
  Candidate := ExpandConstant('{pf}\Kingsoft\WPS Office\wps.exe');
  if FileExists(Candidate) then begin Exe := Candidate; Result := True; exit; end;
  Candidate := ExpandConstant('{pf32}\Kingsoft\WPS Office\wps.exe');
  if FileExists(Candidate) then begin Exe := Candidate; Result := True; exit; end;
end;

function InitializeSetup(): Boolean;
begin
  if not FindWpsExe(WpsExePath) then begin
    MsgBox('未检测到 WPS Office 安装。请先安装 WPS Office，否则无法继续安装 阿蛤（AH32）。', mbCriticalError, MB_OK);
    Result := False;
    exit;
  end;
  Result := True;
end;

procedure InitializeWizard();
begin
  DeepseekPage := CreateInputQueryPage(
    wpSelectDir,
    'DeepSeek API Key',
    '配置 DeepSeek API Key（必需）',
    '请输入 DEEPSEEK_API_KEY。你也可以先留空，安装完成后在 .env 中补充（补充后重启 阿蛤（AH32））。'
  );
  DeepseekPage.Add('DEEPSEEK_API_KEY:', False);
end;

function GetDeepseekKey(Param: string): string;
begin
  Result := '';
  if Assigned(DeepseekPage) then
    Result := DeepseekPage.Values[0];
end;

function ShouldStartBackend(): Boolean;
begin
  Result := Trimmed(GetDeepseekKey('')) <> '';
end;

function ShouldOpenEnv(): Boolean;
begin
  Result := Trimmed(GetDeepseekKey('')) = '';
end;

function GetWpsExe(Param: string): string;
begin
  Result := WpsExePath;
end;

function ShouldOpenWps(): Boolean;
begin
  Result := WpsExePath <> '';
end;
