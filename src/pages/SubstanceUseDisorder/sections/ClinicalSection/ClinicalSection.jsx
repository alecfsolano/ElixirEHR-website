import { sudClinical } from '../../../../data/substanceUseDisorder';
import Section from '../../../../components/layout/Section/Section';
import SudIntro from '../../components/SudIntro/SudIntro';
import styles from './ClinicalSection.module.css';

/**
 * "Clinical Documentation Across Residential, Outpatient and Withdrawal Management" (dark): the
 * intro and the withdrawal management note. The frame repeated the six Part 2 cards here; they are
 * shown once, in the compliance section, so visitors do not read the same cards twice.
 */
function ClinicalSection() {
  const { eyebrow, title, description, note } = sudClinical;

  return (
    <Section tone="dark" spacing="none" className={styles.section} aria-labelledby="sud-clinical-title">
      <SudIntro
        id="sud-clinical-title"
        eyebrow={eyebrow}
        title={title}
        description={description}
        tone="dark"
        className={styles.intro}
      />
      <p className={styles.note}>
        <span>{note}</span>
      </p>
    </Section>
  );
}

export default ClinicalSection;
