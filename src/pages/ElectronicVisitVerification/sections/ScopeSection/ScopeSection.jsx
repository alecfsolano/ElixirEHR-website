import { evvScope } from '../../../../data/electronicVisitVerification';
import Section from '../../../../components/layout/Section/Section';
import EyebrowHeading from '../../../../components/ui/EyebrowHeading/EyebrowHeading';
import styles from './ScopeSection.module.css';

function ScopeSection() {
  const { eyebrow, title, description, columns, rows, note } = evvScope;

  return (
    <Section spacing="none" className={styles.section} aria-labelledby="evv-scope">
      <div className={styles.intro}>
        <EyebrowHeading id="evv-scope" eyebrow={eyebrow} title={title} />
        <p className={styles.description}>{description}</p>
      </div>

      {/* On phones each row becomes a card, with every value under its column name (data-label). */}
      <div className={styles.frame} role="region" aria-label="EVV scope by service area" tabIndex={0}>
        <table className={styles.table}>
          <colgroup>
            <col className={styles.colArea} />
            <col className={styles.colFederal} />
            <col />
          </colgroup>
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
            {rows.map((row) => (
              <tr key={row.area}>
                <th scope="row" data-label={columns[0]}>
                  {row.area}
                </th>
                <td className={styles.federal} data-label={columns[1]}>
                  {row.federal}
                </td>
                <td data-label={columns[2]}>{row.confirm}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className={styles.note}>{note}</p>
    </Section>
  );
}

export default ScopeSection;
