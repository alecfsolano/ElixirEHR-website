import { cn } from '../../../../utils/cn';
import BhIntro from '../../../BehavioralHealth/components/BhIntro/BhIntro';
import styles from './ShIntro.module.css';

/**
 * Section intro for the Student Health frame: Behavioral Health's `BhIntro` at a 48/56 title.
 * `accent` gold marks the frame's "the one to get right" eyebrows; on dark bands the eyebrow is lime.
 * Descriptions flow as normal text; a `\n` in one still starts a new line (white-space: pre-line).
 */
function ShIntro({ accent, className, ...props }) {
  return <BhIntro {...props} className={cn(styles.intro, accent && styles[accent], className)} />;
}

export default ShIntro;
