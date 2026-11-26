import styles from './KeepHyphenated.module.css';

/**
 * Keeps hyphenated words ("No-Shows", "e-book") whole in drawn text, so a line never wraps as
 * "No- / Shows". The rest of the text wraps normally; a non-string `text` is returned as is.
 */
function KeepHyphenated({ text }) {
  if (typeof text !== 'string') return text ?? null;
  return text.split(/([\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)+)/u).map((part, index) =>
    index % 2 ? (
      <span key={index} className={styles.nowrap}>
        {part}
      </span>
    ) : (
      part
    ),
  );
}

export default KeepHyphenated;
