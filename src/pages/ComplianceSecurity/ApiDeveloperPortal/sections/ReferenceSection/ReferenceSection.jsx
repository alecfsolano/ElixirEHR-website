import { Fragment } from 'react';
import { cn } from '../../../../../utils/cn';
import Section from '../../../../../components/layout/Section/Section';
import RichText from '../../../../../components/ui/RichText/RichText';
import ComplianceIntro from '../../../components/ComplianceIntro/ComplianceIntro';
import styles from './ReferenceSection.module.css';

/** An endpoint path with a line-break opportunity after every "/", so it wraps between segments. */
function BreakablePath({ path }) {
  return path.split('/').map((segment, index, parts) => (
    <Fragment key={index}>
      {segment}
      {index < parts.length - 1 && (
        <>
          /<wbr />
        </>
      )}
    </Fragment>
  ));
}

/**
 * One API reference section: intro, then its blocks in source order — endpoint rows (method chip,
 * name, path), labelled code blocks, a status-code table, and small notes with inline code.
 */
function ReferenceSection({ id, tone, eyebrow, title, description, blocks }) {
  const titleId = `${id}-title`;

  return (
    <Section tone={tone} spacing="none" id={id} className={styles.section} aria-labelledby={titleId}>
      <ComplianceIntro id={titleId} eyebrow={eyebrow} title={title} description={description} />

      {blocks.map((block, index) => {
        if (block.type === 'endpoints') {
          return (
            <ul key={index} className={styles.endpoints}>
              {block.items.map((endpoint) => (
                <li key={endpoint.path} className={styles.endpoint}>
                  <span className={cn(styles.method, endpoint.method === 'POST' && styles.post)}>
                    {endpoint.method}
                  </span>
                  <span className={styles.name}>{endpoint.name}</span>
                  <code className={styles.path}>
                    <BreakablePath path={endpoint.path} />
                  </code>
                </li>
              ))}
            </ul>
          );
        }

        if (block.type === 'code') {
          return (
            <div key={index}>
              <p className={styles.codeLabel}>{block.label}</p>
              <pre className={styles.code}>
                <code>{block.code}</code>
              </pre>
            </div>
          );
        }

        if (block.type === 'table') {
          return (
            <div key={index} className={styles.tableWrap}>
              <table className={styles.table}>
                <caption>{block.caption}</caption>
                <thead>
                  <tr>
                    {block.columns.map((column) => (
                      <th key={column} scope="col">
                        {column}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {block.rows.map(([status, meaning, condition]) => (
                    <tr key={status}>
                      <td data-label={block.columns[0]}>
                        <code className={styles.status}>{status}</code>
                      </td>
                      <td className={styles.meaning} data-label={block.columns[1]}>
                        {meaning}
                      </td>
                      <td data-label={block.columns[2]}>{condition}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }

        return (
          <p key={index} className={styles.note}>
            <RichText content={block.text} linkClassName={styles.link} codeClassName={styles.inlineCode} />
          </p>
        );
      })}
    </Section>
  );
}

export default ReferenceSection;
