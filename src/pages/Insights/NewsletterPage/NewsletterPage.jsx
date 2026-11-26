import { useState } from 'react';
import { insightsPages } from '../../../data/insights';
import Icon from '../../../components/ui/Icon/Icon';
import InsightsShell from '../components/InsightsShell/InsightsShell';
import WeeklyBriefing from '../components/WeeklyBriefing/WeeklyBriefing';
// The card reuses the Webinars page's empty-state styles so both read as the same pattern.
import styles from '../WebinarListing/WebinarListing.module.css';

const page = insightsPages.newsletter;

/**
 * /newsletter — the Newsletter page in the Insights section (its own URL, like Webinars or Videos).
 * No newsletter issues are published on the site, so the page gives the approved page description
 * beside The Weekly Briefing sign-up form. The card does not repeat the form's title or Subscribe
 * button: the form sits right next to it (below it on a phone).
 */
function NewsletterPage() {
  const [query, setQuery] = useState('');

  return (
    <InsightsShell
      documentTitle={page.documentTitle}
      title={page.title}
      query={query}
      onQueryChange={setQuery}
      aside={<WeeklyBriefing />}
    >
      <section className={styles.empty} aria-label={page.title}>
        <span className={styles.emptyIcon} aria-hidden="true">
          <Icon name="document" size={28} />
        </span>
        <p className={styles.emptyText}>{page.intro}</p>
      </section>
    </InsightsShell>
  );
}

export default NewsletterPage;
