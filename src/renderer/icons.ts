const paths = {
  "memory": '<path d="M8 3h8a3 3 0 0 1 3 3v15l-7-4-7 4V6a3 3 0 0 1 3-3Z"/><path d="M9 8h6M9 11h4"/>',
  "back": '<path d="m12 5-7 7 7 7M5 12h15"/>',
  "task": "<rect x=\"5\" y=\"4\" width=\"14\" height=\"17\" rx=\"2\"/><rect x=\"9\" y=\"2\" width=\"6\" height=\"4\" rx=\"1\"/><path d=\"M9 11h6M9 15h4\"/>",
  "close": "<path d=\"m6 6 12 12M6 18 18 6\"/>",
  "settings": "<path d=\"M4 7h8m4 0h4M4 17h2m4 0h10\"/><circle cx=\"14\" cy=\"7\" r=\"2\"/><circle cx=\"8\" cy=\"17\" r=\"2\"/>",
  "hide": "<path d=\"M5 12h14\"/>",
  "phone": "<path d=\"M7 3H4a1 1 0 0 0-1 1c0 9.4 7.6 17 17 17a1 1 0 0 0 1-1v-3l-5-2-2 2a14 14 0 0 1-7-7l2-2-2-5Z\"/>",
  "hangup": "<path d=\"M3 13c5-5 13-5 18 0v5h-5v-4a12 12 0 0 0-8 0v4H3v-5Z\"/>",
  "mic": "<rect x=\"9\" y=\"3\" width=\"6\" height=\"12\" rx=\"3\"/><path d=\"M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8\"/>",
  "micOff": "<path d=\"m3 3 18 18M9 9v3a3 3 0 0 0 5.1 2.1M9 5a3 3 0 0 1 6 1v3M5 10v2a7 7 0 0 0 11.9 4.9M19 10v2M12 19v3M8 22h8\"/>",
  "speaker": "<path d=\"m11 5-6 4H2v6h3l6 4V5ZM15 8a6 6 0 0 1 0 8M18 5a10 10 0 0 1 0 14\"/>",
  "speakerOff": "<path d=\"m11 5-6 4H2v6h3l6 4V5Zm6 4 5 6m0-6-5 6\"/>",
  "keyboard": "<rect x=\"2\" y=\"5\" width=\"20\" height=\"14\" rx=\"3\"/><path d=\"M6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 12h.01M10 12h.01M14 12h.01M18 12h.01M7 15h10\"/>",
  "terminal": "<rect x=\"2\" y=\"4\" width=\"20\" height=\"16\" rx=\"3\"/><path d=\"m6 9 3 3-3 3m7 0h5\"/>",
  "stop": "<rect x=\"6\" y=\"6\" width=\"12\" height=\"12\" rx=\"2\"/>",
  "open": "<path d=\"M14 3h7v7m0-7-11 11M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5\"/>",
  "send": "<path d=\"m3 3 19 9-19 9 4-9-4-9Zm4 9h15\"/>",
  "import": "<path d=\"M12 3v12m-4-4 4 4 4-4M4 16v4h16v-4\"/>",
  "check": "<path d=\"m5 12 4 4L19 6\"/>"
} as const;
export function icon(name: keyof typeof paths) { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + paths[name] + '</svg>'; }
