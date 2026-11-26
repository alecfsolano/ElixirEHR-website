import { cn } from '../../../../utils/cn';
import BhIntro from '../../../BehavioralHealth/components/BhIntro/BhIntro';
import styles from './OpIntro.module.css';

/**
 * Section intro for the Outpatient Clinics frame: Behavioral Health's `BhIntro` at this frame's
 * 52/56 title. On a dark section the eyebrow is lime or yellow (`accent`); on a light one both are the
 * dark olive used by the site's other eyebrows, since lime or yellow 11px caps on near-white are unreadable.
 */
function OpIntro({ accent = 'lime', className, ...props }) {
  const eyebrowTone = props.tone === 'dark' ? accent : 'onLight';
  return <BhIntro {...props} className={cn(styles.intro, styles[eyebrowTone], className)} />;
}

export default OpIntro;
