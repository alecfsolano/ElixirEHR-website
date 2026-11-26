import { fsMedicaidData } from '../../../../data/evvFieldService';
import Section from '../../../../components/layout/Section/Section';
import EyebrowHeading from '../../../../components/ui/EyebrowHeading/EyebrowHeading';
import styles from './MedicaidDataSection.module.css';

function MedicaidDataSection() {
  const { eyebrow, title, description, columns, rows } = fsMedicaidData;

  return (
    <Section tone="surface" spacing="none" className={styles.section} aria-labelledby="fs-medicaid">
      <EyebrowHeading id="fs-medicaid" eyebrow={eyebrow} title={title} className={styles.heading} />
      <p className={styles.description}>{description}</p>

      {/* On phones each row stacks as a label/value card (see the CSS) instead of scrolling sideways. */}
      <div className={styles.frame} role="region" aria-label="Medicaid EVV data captured by Elixir" tabIndex={0}>
        <table className={styles.table}>
          <thead>
            <tr>
              {columns.map((column) => (
                <th key={column} scope="col">
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(([information, capture]) => (
              <tr key={information}>
                <th scope="row">{information}</th>
                <td data-label={columns[1]}>{capture}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

export default MedicaidDataSection;
