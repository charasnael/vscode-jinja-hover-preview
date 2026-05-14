const vscode = require("vscode");

const CONFIG_SECTION = "jinjaConfigHover";
const DEFAULT_VARIABLES_FOLDER = "variables";
const DEFAULT_VARIABLE_SOURCES = [DEFAULT_VARIABLES_FOLDER];
const DEFAULT_LANGUAGES = [
  "jinja",
  "jinja-html",
  "plaintext",
  "python",
  "conf",
  "ini",
  "xml",
  "properties",
  "nginx",
  "json",
  "jsonc",
  "yaml",
  "haproxy",
  "html",
];
const DEFAULT_FILE_PATTERNS = [
  "**/*.conf",
  "**/*.properties",
  "**/*nginx*.conf",
  "**/*haproxy*.cfg",
  "**/*haproxy*.conf",
];

let hoverRegistration;
let settingsView;

function activate(context) {
  settingsView = new SettingsViewProvider(context.extensionUri);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      "jinjaConfigHover.settingsView",
      settingsView,
    ),
    vscode.commands.registerCommand("jinjaConfigHover.openSettings", () => {
      vscode.commands.executeCommand("workbench.action.openSettings", CONFIG_SECTION);
    }),
    vscode.window.onDidChangeActiveTextEditor(() => settingsView.refresh()),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration(CONFIG_SECTION)) {
        return;
      }

      registerHoverProvider(context);
      settingsView.refresh();
    }),
  );

  registerHoverProvider(context);
}

function registerHoverProvider(context) {
  hoverRegistration?.dispose();
  hoverRegistration = vscode.languages.registerHoverProvider(
    getDocumentSelectors(),
    {
      async provideHover(document, position) {
        const selectionPreview = await getSelectionPreview(document, position);
        if (selectionPreview) {
          return selectionPreview;
        }

        const line = document.lineAt(position.line).text;
        const reference = findConfigReference(line, position.character);

        if (!reference) {
          return undefined;
        }

        const values = await collectVariableValues(reference.path, document.uri);
        if (values.length === 0) {
          return undefined;
        }

        const markdown = new vscode.MarkdownString();
        markdown.appendMarkdown(`\`${reference.expression}\`\n\n`);
        for (const value of values) {
          markdown.appendMarkdown(`- **${value.file}**: \`${String(value.value)}\`\n`);
        }

        return new vscode.Hover(
          markdown,
          new vscode.Range(
            position.line,
            reference.startCharacter,
            position.line,
            reference.endCharacter,
          ),
        );
      },
    },
  );

  context.subscriptions.push(hoverRegistration);
}

function getDocumentSelectors() {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const languages = normalizeStringArray(config.get("languages"), DEFAULT_LANGUAGES);
  const filePatterns = normalizeStringArray(
    config.get("filePatterns"),
    DEFAULT_FILE_PATTERNS,
  );

  return [
    ...languages.map((language) => ({ language })),
    ...filePatterns.map((pattern) => ({ pattern })),
  ];
}

async function getSelectionPreview(document, position) {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.toString() !== document.uri.toString()) {
    return undefined;
  }

  const selection = editor.selection;
  if (selection.isEmpty || !selection.contains(position)) {
    return undefined;
  }

  const selectedText = document.getText(selection);
  const previews = await renderSelectedTextForVariables(selectedText, document.uri);
  if (previews.length === 0) {
    return undefined;
  }

  const markdown = new vscode.MarkdownString();
  markdown.appendMarkdown("Selected Jinja preview\n\n");
  for (const preview of previews) {
    markdown.appendMarkdown(`- **${preview.file}**: `);
    markdown.appendText(`${preview.value}\n`);
  }

  return new vscode.Hover(markdown, selection);
}

async function renderSelectedTextForVariables(selectedText, documentUri) {
  const references = findJinjaConfigReferences(selectedText);
  if (references.length === 0) {
    return [];
  }

  const configs = await loadVariableConfigs(documentUri);
  return configs
    .map(({ file, config }) => {
      const value = renderJinjaConfigText(selectedText, references, config);
      return { file, value };
    })
    .filter((preview) => preview.value !== undefined);
}

function findJinjaConfigReferences(text) {
  const references = [];
  const pattern = /\{\{\s*(config(?:(?:\.[A-Za-z_][\w-]*)|(?:\[['"][^'"]+['"]\]))+)\s*\}\}/g;
  let match;

  while ((match = pattern.exec(text)) !== null) {
    references.push({
      tag: match[0],
      expression: match[1],
      path: parseConfigPath(match[1]),
    });
  }

  return references;
}

function renderJinjaConfigText(text, references, config) {
  let rendered = text;

  for (const reference of references) {
    const value = getPath(config, reference.path);
    if (value === undefined) {
      return undefined;
    }

    rendered = rendered.replace(reference.tag, String(value));
  }

  return rendered;
}

function normalizeStringArray(value, fallback) {
  if (!Array.isArray(value)) {
    return fallback;
  }

  const normalized = value
    .map((entry) => String(entry).trim())
    .filter((entry) => entry.length > 0);
  return normalized.length > 0 ? [...new Set(normalized)] : fallback;
}

class SettingsViewProvider {
  constructor(extensionUri) {
    this.extensionUri = extensionUri;
  }

  resolveWebviewView(webviewView) {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };
    webviewView.webview.onDidReceiveMessage((message) => {
      if (message.command === "openSettings") {
        vscode.commands.executeCommand("jinjaConfigHover.openSettings");
      }
    });
    this.refresh();
  }

  refresh() {
    if (!this.view) {
      return;
    }

    this.view.webview.html = getSettingsHtml(this.view.webview);
  }
}

function getSettingsHtml(webview) {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const folder = config.get("variablesFolder", DEFAULT_VARIABLES_FOLDER);
  const variableSources = getConfiguredVariableSources();
  const languages = normalizeStringArray(config.get("languages"), DEFAULT_LANGUAGES);
  const filePatterns = normalizeStringArray(
    config.get("filePatterns"),
    DEFAULT_FILE_PATTERNS,
  );
  const currentLanguage =
    vscode.window.activeTextEditor?.document.languageId || "No active editor";
  const nonce = getNonce();

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { padding: 12px; color: var(--vscode-foreground); font-family: var(--vscode-font-family); }
    h2 { font-size: 13px; margin: 0 0 8px; }
    h3 { font-size: 12px; margin: 12px 0 6px; }
    .section { margin-bottom: 18px; }
    .value { background: var(--vscode-textCodeBlock-background); padding: 6px 8px; border-radius: 4px; word-break: break-all; }
    ul { margin: 8px 0 0; padding-left: 18px; }
    li { margin: 3px 0; }
    code { background: var(--vscode-textCodeBlock-background); padding: 1px 3px; border-radius: 3px; }
    button { width: 100%; margin: 0 0 8px; padding: 6px 8px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: 0; border-radius: 2px; cursor: pointer; }
    button:hover { background: var(--vscode-button-hoverBackground); }
    .muted { color: var(--vscode-descriptionForeground); }
  </style>
</head>
<body>
  <div class="section">
    <button id="openSettings">Open Settings</button>
  </div>

  <div class="section">
    <h2>How to use the extension</h2>

    <h3>Single value hover</h3>
    <p>Hover a config reference to see its value for every selected variables file.</p>
    <ul>
      <li><code>{{ config.smtp.postmaster }}</code></li>
      <li><code>{{ config["smtp"]["postmaster"] }}</code></li>
      <li><code>{{ config.imap.port }}</code></li>
    </ul>

    <h3>Selected text preview</h3>
    <p>Select text containing one or more Jinja config references, then hover inside the selection.</p>
    <div class="value">{{ config.imap.port }} and the postmaster is {{ config["smtp"]["postmaster"] }}</div>
    <p class="muted">The hover shows the fully resolved selected text once per variables file.</p>
  </div>

  <div class="section">
    <h2>Selecting variables location</h2>

    <h3>Variable sources</h3>
    <ul>${variableSources.map((source) => `<li>${escapeHtml(source)}</li>`).join("")}</ul>
    <p class="muted">Sources can be YAML files or folders containing YAML files.</p>

    <h3>Setting</h3>
    <p>Edit <code>jinjaConfigHover.variableSources</code> in VS Code settings to set one or more YAML files or folders containing <code>.yml</code> or <code>.yaml</code> files.</p>
    <p>Relative paths resolve from the workspace folder. URI values and <code>\${workspaceFolder}</code> are also supported.</p>

    <h3>Legacy variables folder</h3>
    <div class="value">${escapeHtml(folder)}</div>
    <p class="muted">Used only when no variable sources are configured.</p>
  </div>

  <div class="section">
    <h2>Language enabled for previewing</h2>

    <h3>Current language</h3>
    <div class="value">${escapeHtml(currentLanguage)}</div>

    <h3>Enabled languages</h3>
    <ul>${languages.map((language) => `<li>${escapeHtml(language)}</li>`).join("")}</ul>

    <h3>File name enablement</h3>
    <ul>${filePatterns.map((pattern) => `<li>${escapeHtml(pattern)}</li>`).join("")}</ul>
    <p>Edit <code>jinjaConfigHover.languages</code> in settings to add VS Code language IDs.</p>
    <p>Edit <code>jinjaConfigHover.filePatterns</code> for filename-based matches like <code>**/*.conf</code> or <code>**/*.properties</code>.</p>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.getElementById("openSettings").addEventListener("click", () => {
      vscode.postMessage({ command: "openSettings" });
    });
  </script>
</body>
</html>`;
}

function findConfigReference(line, character) {
  const patterns = [
    /\{\{\s*(config(?:(?:\.[A-Za-z_][\w-]*)|(?:\[['"][^'"]+['"]\]))+)\s*\}\}/g,
    /\b(config(?:(?:\.[A-Za-z_][\w-]*)|(?:\[['"][^'"]+['"]\]))+)\b/g,
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(line)) !== null) {
      const expression = match[1];
      const expressionStart = match.index + match[0].indexOf(expression);
      const expressionEnd = expressionStart + expression.length;

      if (character < expressionStart || character > expressionEnd) {
        continue;
      }

      return {
        expression,
        path: parseConfigPath(expression),
        startCharacter: expressionStart,
        endCharacter: expressionEnd,
      };
    }
  }

  return undefined;
}

function parseConfigPath(expression) {
  const parts = [];
  const pattern = /\.([A-Za-z_][\w-]*)|\[['"]([^'"]+)['"]\]/g;
  let match;

  while ((match = pattern.exec(expression)) !== null) {
    parts.push(match[1] || match[2]);
  }

  return parts;
}

async function collectVariableValues(configPath, documentUri) {
  const configs = await loadVariableConfigs(documentUri);
  return configs
    .map(({ file, config }) => ({ file, value: getPath(config, configPath) }))
    .filter((entry) => entry.value !== undefined);
}

async function loadVariableConfigs(documentUri) {
  const files = await resolveVariableFiles(documentUri);
  const configs = [];

  for (const fileUri of files) {
    try {
      const bytes = await vscode.workspace.fs.readFile(fileUri);
      const config = parseSimpleYaml(new TextDecoder("utf-8").decode(bytes));
      configs.push({
        file: formatVariableFileLabel(fileUri),
        config,
      });
    } catch {
      // Ignore unreadable files so one bad source does not disable all previews.
    }
  }

  return configs;
}

async function resolveVariableFiles(documentUri) {
  const files = [];

  for (const source of getConfiguredVariableSources(documentUri)) {
    const sourceUri = resolveConfiguredUri(source, documentUri);
    if (!sourceUri) {
      continue;
    }

    try {
      const stat = await vscode.workspace.fs.stat(sourceUri);
      if (stat.type === vscode.FileType.File && isYamlUri(sourceUri)) {
        files.push(sourceUri);
      }

      if (stat.type === vscode.FileType.Directory) {
        const entries = await vscode.workspace.fs.readDirectory(sourceUri);
        for (const [name, type] of entries) {
          const childUri = vscode.Uri.joinPath(sourceUri, name);
          if (type === vscode.FileType.File && isYamlUri(childUri)) {
            files.push(childUri);
          }
        }
      }
    } catch {
      // Missing or inaccessible sources are ignored.
    }
  }

  return [...new Map(files.map((file) => [file.toString(), file])).values()].sort((a, b) =>
    a.toString().localeCompare(b.toString()),
  );
}

function getConfiguredVariableSources(documentUri) {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION, documentUri);
  const inspectedSources = config.inspect("variableSources");
  const configuredSources =
    inspectedSources?.workspaceFolderValue ||
    inspectedSources?.workspaceValue ||
    inspectedSources?.globalValue;

  if (configuredSources !== undefined) {
    return normalizeStringArray(configuredSources, DEFAULT_VARIABLE_SOURCES);
  }

  const legacyFolder = config
    .get("variablesFolder", DEFAULT_VARIABLES_FOLDER)
    .trim();
  return legacyFolder ? [legacyFolder] : DEFAULT_VARIABLE_SOURCES;
}

function resolveConfiguredUri(configuredPath, documentUri) {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION, documentUri);
  const configuredFolder = config
    .get("variablesFolder", DEFAULT_VARIABLES_FOLDER)
    .trim();
  const source = configuredPath || configuredFolder || DEFAULT_VARIABLES_FOLDER;
  const workspaceFolder = documentUri
    ? vscode.workspace.getWorkspaceFolder(documentUri)
    : undefined;
  const workspaceUri =
    workspaceFolder?.uri || vscode.workspace.workspaceFolders?.[0]?.uri;

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(source)) {
    return vscode.Uri.parse(source);
  }

  if (workspaceUri && source.startsWith("${workspaceFolder}")) {
    return joinUriPath(workspaceUri, source.slice("${workspaceFolder}".length));
  }

  if (workspaceUri && !isLikelyAbsoluteLocalPath(source)) {
    return joinUriPath(workspaceUri, source);
  }

  if (isLikelyAbsoluteLocalPath(source)) {
    return vscode.Uri.file(source);
  }

  return workspaceUri ? joinUriPath(workspaceUri, source) : undefined;
}

function joinUriPath(baseUri, relativePath) {
  const segments = relativePath
    .replace(/\\/g, "/")
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0 && segment !== ".");
  return segments.length > 0 ? vscode.Uri.joinPath(baseUri, ...segments) : baseUri;
}

function isLikelyAbsoluteLocalPath(value) {
  return /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith("/");
}

function isYamlUri(uri) {
  const path = uri.path.toLowerCase();
  return path.endsWith(".yml") || path.endsWith(".yaml");
}

function formatVariableFileLabel(uri) {
  const relative = vscode.workspace.asRelativePath(uri, false);
  if (relative && relative !== uri.toString()) {
    return relative.replace(/\\/g, "/");
  }

  const parts = uri.path.split("/").filter(Boolean);
  return parts[parts.length - 1] || uri.toString();
}

function parseSimpleYaml(text) {
  const root = {};
  const stack = [{ indent: -1, value: root }];

  for (const rawLine of text.split(/\r?\n/)) {
    const lineWithoutComment = rawLine.replace(/\s+#.*$/, "");
    if (!lineWithoutComment.trim()) {
      continue;
    }

    const indent = lineWithoutComment.match(/^\s*/)[0].length;
    const match = lineWithoutComment.trim().match(/^([^:]+):(.*)$/);
    if (!match) {
      continue;
    }

    const key = match[1].trim().replace(/^['"]|['"]$/g, "");
    const rawValue = match[2].trim();

    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }

    const parent = stack[stack.length - 1].value;
    if (rawValue === "") {
      parent[key] = {};
      stack.push({ indent, value: parent[key] });
    } else {
      parent[key] = parseScalar(rawValue);
    }
  }

  return root;
}

function parseScalar(value) {
  const unquoted = value.replace(/^['"]|['"]$/g, "");

  if (/^-?\d+$/.test(unquoted)) {
    return Number(unquoted);
  }

  if (unquoted === "true") {
    return true;
  }

  if (unquoted === "false") {
    return false;
  }

  if (unquoted === "null") {
    return null;
  }

  return unquoted;
}

function getPath(value, configPath) {
  return configPath.reduce((current, key) => {
    if (current === undefined || current === null) {
      return undefined;
    }

    return current[key];
  }, value);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function getNonce() {
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let text = "";
  for (let i = 0; i < 32; i += 1) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

function deactivate() {
  hoverRegistration?.dispose();
}

module.exports = {
  activate,
  deactivate,
};
