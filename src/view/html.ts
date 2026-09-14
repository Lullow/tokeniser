export interface HtmlOptions {
  cspSource: string;
  scriptUri: string;
  styleUri: string;
  nonce: string;
}

const attribute = (value: string): string => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/**
 * Threat model: no external resources, no inline styles or scripts except the one script
 * with a fresh nonce. The webview builds all data as text nodes.
 */
export function contentSecurityPolicy(cspSource: string, nonce: string): string {
  return [`default-src 'none'`, `style-src ${cspSource}`, `font-src ${cspSource}`, `script-src 'nonce-${nonce}'`].join("; ");
}

export function viewHtml(options: HtmlOptions): string {
  return `<!DOCTYPE html>
<html lang="sv">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${attribute(contentSecurityPolicy(options.cspSource, options.nonce))}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${attribute(options.styleUri)}">
<title>Tokeniser</title>
</head>
<body>
<main id="root" class="root"></main>
<script nonce="${attribute(options.nonce)}" src="${attribute(options.scriptUri)}"></script>
</body>
</html>`;
}
