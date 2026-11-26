const NO_WRAP = { whiteSpace: 'nowrap' };

/**
 * Keeps hyphenated words ("CMS-1500", "Salesforce-native", "200-Page") whole in a drawn heading,
 * so it never wraps as "CMS- / 1500". The text itself is unchanged (search, copy and screen
 * readers see the same string); only the line breaking inside those words is turned off.
 */
export function keepHyphenated(text) {
  if (typeof text !== 'string') return text;
  return text.split(/([\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)+)/u).map((part, index) =>
    index % 2 ? (
      <span key={index} style={NO_WRAP}>
        {part}
      </span>
    ) : (
      part
    ),
  );
}
