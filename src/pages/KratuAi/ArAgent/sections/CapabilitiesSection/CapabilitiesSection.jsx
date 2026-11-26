import { arCapabilities } from '../../../../../data/arAgent';
import Section from '../../../../../components/layout/Section/Section';
import styles from './CapabilitiesSection.module.css';

/** "A/R Agent capabilities" (dark) — eight model cards, each with its stage pill. */
function CapabilitiesSection() {
  const { id, eyebrow, title, description, items } = arCapabilities;

  return (
    <Section id={id} tone="dark" spacing="none" className={styles.section} aria-labelledby="ar-capabilities-title">
      <div className={styles.head}>
        <div>
          <p className={styles.eyebrow}>{eyebrow}</p>
          <h2 id="ar-capabilities-title" className={styles.heading}>
            {title}
          </h2>
        </div>
        <p className={styles.description}>{description}</p>
      </div>
      <ul className={styles.grid}>
        {items.map((item) => (
          <li key={item.title} className={styles.card}>
            <p className={styles.top}>
              <span className={styles.mark} aria-hidden="true" />
              <span className={styles.tag}>{item.tag}</span>
            </p>
            <h3 className={styles.title}>{item.title}</h3>
            <p className={styles.text}>{item.text}</p>
          </li>
        ))}
      </ul>
    </Section>
  );
}

export default CapabilitiesSection;
