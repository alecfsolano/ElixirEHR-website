import { getLatestPosts, postTypes } from '../../../posts';
import { cn } from '../../../utils/cn';
import Container from '../../layout/Container/Container';
import PostSeo from '../PostSeo/PostSeo';
import PostHero from '../PostHero/PostHero';
import PostContent from '../PostContent/PostContent';
import PostSidebar from '../PostSidebar/PostSidebar';
import PostShare from '../PostShare/PostShare';
import styles from './PostDetailTemplate.module.css';

/** The article column's width at desktop (see .layout). */
const COLUMN_WIDTH = 757;

/**
 * The one inner-page template for every post type (blog, press release, case study, release note,
 * e-book, webinar), built from the Figma "Press Release" detail frame. Everything shown comes from
 * the post object; sections without data (media contact, tags, about, latest posts) are omitted.
 */
function PostDetailTemplate({ post }) {
  const type = postTypes[post.type];
  const blocks = post.content?.length ? post.content : [{ type: 'lead', text: post.excerpt }];
  // The sidebar's sections (see PostSidebar); a post with none of them (an only e-book, say) gets
  // a single centred column instead of an empty right third.
  const hasSidebar = Boolean(post.mediaContact || post.tags?.length || getLatestPosts(post).length);
  const { width, height } = post.heroImage ?? {};

  return (
    <>
      <PostSeo post={post} type={type} />
      <article>
        <PostHero post={post} type={type} />
        <Container className={cn(styles.layout, !hasSidebar && styles.single)}>
          <div className={styles.main}>
            {post.heroImage && (
              // An image narrower than the 757px column (legacy 360×240 art, say) sits centred on a
              // neutral panel the column's width, so it reads as a framed figure, not a stray thumbnail.
              <div className={cn(styles.heroFrame, width < COLUMN_WIDTH && styles.heroFramed)}>
                <img
                  src={post.heroImage.src}
                  alt={post.heroImage.alt}
                  width={post.heroImage.width}
                  height={post.heroImage.height}
                  fetchPriority="high"
                  className={styles.heroImage}
                  // The banner keeps the post's declared proportions (e.g. 757×324) whatever the image
                  // file's own ratio; CSS crops it with object-fit: cover. It is never drawn wider than
                  // its declared width, so small legacy images (360×240) are not upscaled and blurred.
                  style={width && height ? { aspectRatio: `${width} / ${height}`, maxWidth: width } : undefined}
                />
              </div>
            )}
            <PostContent blocks={blocks} />
            {post.about && (
              <section className={styles.about}>
                <h2 className={styles.aboutTitle}>{post.about.title}</h2>
                <p className={styles.aboutText}>{post.about.text}</p>
              </section>
            )}
            <PostShare label={type.shareLabel} title={post.title} />
          </div>
          {hasSidebar && <PostSidebar post={post} type={type} />}
        </Container>
      </article>
    </>
  );
}

export default PostDetailTemplate;
