const RISK_PATTERNS = [
  /\b(?:Remove-Item|rm|rmdir|del)\b.*(?:-Recurse|-r|-rf|\/s)\b/iu,
  /\bgit\s+(?:reset\s+--hard|clean\s+-[a-z]*f|push\s+--force)\b/iu,
  /\b(?:Format-Volume|Clear-Disk|Stop-Computer|Restart-Computer)\b/iu,
  /(?:^|[\s;&|])(?:curl|iwr|Invoke-WebRequest)\b[^\r\n|]*\|\s*(?:iex|Invoke-Expression)\b/iu
];
const MAX_PASTE_LENGTH = 64 * 1024;

function analyzePaste(text) {
  const value = typeof text === 'string' ? text : '';
  const lines = value.split(/\r\n|\r|\n/u);
  const reasons = [];
  if (lines.length > 1) {
    reasons.push('multiline');
  }
  if (RISK_PATTERNS.some((pattern) => pattern.test(value))) {
    reasons.push('dangerous-pattern');
  }
  const unsafeControlCharacters = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value);
  if (unsafeControlCharacters) {
    reasons.push('control-character');
  }
  const tooLong = value.length > MAX_PASTE_LENGTH;
  if (tooLong) {
    reasons.push('too-long');
  }
  return {
    text: value,
    empty: value.length === 0,
    multiline: lines.length > 1,
    risky: reasons.length > 0,
    unsafeControlCharacters,
    tooLong,
    reasons,
    preview: value.length > 4000 ? `${value.slice(0, 4000)}\n… (미리보기 생략)` : value
  };
}

function encodeTerminalInput(
  text,
  { mode = 'insert', bracketedPaste = false, allowMultiline = false } = {}
) {
  const analysis = analyzePaste(text);
  if (analysis.empty || !['insert', 'execute'].includes(mode)) {
    return null;
  }
  if (analysis.unsafeControlCharacters || analysis.tooLong) {
    return null;
  }
  if (analysis.multiline && !bracketedPaste && !allowMultiline) {
    return null;
  }
  const normalizedText = analysis.text.replace(/\r\n|\r|\n/gu, '\r');
  const payload = bracketedPaste
    ? `\u001b[200~${normalizedText}\u001b[201~`
    : normalizedText;
  return mode === 'execute' ? `${payload}\r` : payload;
}

module.exports = { MAX_PASTE_LENGTH, analyzePaste, encodeTerminalInput };
