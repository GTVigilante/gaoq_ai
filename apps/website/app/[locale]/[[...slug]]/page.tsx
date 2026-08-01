import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { LeadForm } from '../../components/lead-form';
import { dictionary, locales, routeTitle, serviceSlugs, type Locale } from '../../lib/content';
import { getPublishedContent, type PublishedContent } from '../../lib/cms';

interface PageProps {
  readonly params: Promise<{ locale: string; slug?: string[] }>;
  readonly searchParams?: Promise<{ audience?: string }>;
}

export function generateStaticParams() {
  const paths = [[], ['creators'], ['brands'], ['cases'], ['insights'], ['about'], ['contact'],
    ['privacy'], ['cookies'], ['terms']];
  return locales.flatMap((locale) => [
    ...paths.map((slug) => ({ locale, slug })),
    ...serviceSlugs.map((service) => ({ locale, slug: ['services', service] })),
  ]);
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale: rawLocale, slug = [] } = await params;
  if (!locales.includes(rawLocale as Locale)) return {};
  const locale = rawLocale as Locale;
  const title = routeTitle(locale, slug);
  const origin = process.env.NEXT_PUBLIC_WEBSITE_ORIGIN ?? 'http://localhost:3002';
  const path = slug.join('/');
  return {
    title,
    alternates: {
      canonical: `${origin}/${locale}${path === '' ? '' : `/${path}`}`,
      languages: {
        'zh-CN': `${origin}/zh-CN${path === '' ? '' : `/${path}`}`,
        en: `${origin}/en${path === '' ? '' : `/${path}`}`,
      },
    },
    openGraph: { title, type: 'website', locale: locale === 'zh-CN' ? 'zh_CN' : 'en_US' },
  };
}

export default async function WebsitePage({ params, searchParams }: PageProps) {
  const { locale: rawLocale, slug = [] } = await params;
  if (!locales.includes(rawLocale as Locale) || !validPath(slug)) notFound();
  const locale = rawLocale as Locale;
  const copy = dictionary(locale);
  const serviceNames = copy.services
    .map((service) => service.at(0))
    .filter((value): value is string => typeof value === 'string');
  const alternate = locale === 'zh-CN' ? 'en' : 'zh-CN';
  const path = slug.join('/');
  const isHome = slug.length === 0;
  const isContact = slug[0] === 'contact';
  const query = await searchParams;
  const audience = query?.audience === 'brand' ? 'brand' : 'creator';
  const cmsType = slug[0] === 'insights' && slug.length === 2 ? 'article' :
    slug[0] === 'cases' && slug.length === 2 ? 'case' :
      slug[0] === 'services' && slug.length === 2 ? 'service' : 'page';
  const cmsSlug = cmsType === 'page' ? (slug.length === 0 ? 'home' : slug.join('-')) :
    String(slug[1]);
  const cmsPage = await getPublishedContent(locale, cmsType, cmsSlug);
  const origin = process.env.NEXT_PUBLIC_WEBSITE_ORIGIN ?? 'http://localhost:3002';

  return (
    <main>
      <script type="application/ld+json">{JSON.stringify({
        '@context': 'https://schema.org',
        '@type': isHome ? 'Organization' : 'WebPage',
        name: isHome ? '告趣 GaoQ' : routeTitle(locale, slug),
        url: `${origin}/${locale}${path === '' ? '' : `/${path}`}`,
        inLanguage: locale,
        ...(isHome ? {
          description: copy.summary,
          knowsAbout: serviceNames,
        } : {}),
      }).replaceAll('<', '\\u003c')}</script>
      <header className="site-header">
        <Link href={`/${locale}`} className="brand"><span>GQ</span><strong>告趣 GaoQ</strong></Link>
        <nav aria-label={locale === 'zh-CN' ? '主导航' : 'Primary navigation'}>
          {copy.nav.map((label, index) => (
            <Link key={label} href={`/${locale}/${copy.navLinks[index]}`}>{label}</Link>
          ))}
        </nav>
        <div className="header-actions">
          <Link className="language" href={`/${alternate}${path === '' ? '' : `/${path}`}`}>
            {alternate === 'en' ? 'EN' : '中'}
          </Link>
          <Link className="nav-cta" href={`/${locale}/contact`}>{copy.contact}</Link>
        </div>
      </header>

      {isContact ? (
        <section className="contact-page">
          <p className="kicker">{locale === 'zh-CN' ? '预约咨询' : 'LET’S TALK'}</p>
          <h1>{copy.finalTitle}</h1>
          <p>{copy.finalText}</p>
          <LeadForm locale={locale} audience={audience} />
        </section>
      ) : cmsPage !== null ? <CmsPage locale={locale} content={cmsPage} /> : isHome ? <Home locale={locale} /> : (
        <EditorialPage locale={locale} slug={slug} />
      )}

      <footer>
        <div><Link href={`/${locale}`} className="brand"><span>GQ</span><strong>告趣 GaoQ</strong></Link><p>{copy.footer}</p></div>
        <div className="footer-links">
          <Link href={`/${locale}/privacy`}>{locale === 'zh-CN' ? '隐私政策' : 'Privacy'}</Link>
          <Link href={`/${locale}/cookies`}>Cookie</Link>
          <Link href={`/${locale}/terms`}>{locale === 'zh-CN' ? '服务条款' : 'Terms'}</Link>
        </div>
        <small>© {new Date().getFullYear()} GaoQ. All rights reserved.</small>
      </footer>
    </main>
  );
}

function CmsPage({ locale, content }: { readonly locale: Locale; readonly content: PublishedContent }) {
  const copy = dictionary(locale);
  return <section className="editorial-page cms-page">
    <p className="kicker">GAOQ / CMS REVISION {content.revision}</p>
    <h1>{content.title}</h1>
    {content.summary !== '' ? <p className="editorial-intro">{content.summary}</p> : null}
    {content.blocks.map((block, index) => {
      const title = typeof block.data.title === 'string' ? block.data.title : '';
      const body = typeof block.data.body === 'string' ? block.data.body : '';
      return <article className={`cms-block cms-block-${block.type}`} key={`${block.type}-${index}`}>
        <span>{String(index + 1).padStart(2, '0')}</span>
        {title !== '' ? <h2>{title}</h2> : null}
        {body !== '' ? <p>{body}</p> : null}
      </article>;
    })}
    <Link className="editorial-cta" href={`/${locale}/contact${content.slug === 'brands' ? '?audience=brand' : ''}`}>{copy.contact} ↗</Link>
  </section>;
}

function Home({ locale }: { readonly locale: Locale }) {
  const copy = dictionary(locale);
  return <>
    <section className="home-hero">
      <div className="orb orb-one" /><div className="orb orb-two" />
      <p className="kicker">{copy.eyebrow}</p>
      <h1>{copy.title.split('\n').map((line) => <span key={line}>{line}</span>)}</h1>
      <p className="hero-summary">{copy.summary}</p>
      <div className="hero-buttons">
        <Link href={`/${locale}/creators`}>{copy.creatorCta}<span>↗</span></Link>
        <Link href={`/${locale}/brands`}>{copy.brandCta}<span>↗</span></Link>
      </div>
      <div className="hero-signal"><i /><span>{locale === 'zh-CN' ? '内容正在发生，经营正在进化' : 'Creativity moves. Operations evolve.'}</span></div>
    </section>
    <section className="services-section">
      <div className="section-heading"><p>01 / CAPABILITIES</p><h2>{copy.serviceTitle}</h2><span>{copy.serviceIntro}</span></div>
      <div className="service-grid">{copy.services.map((service, index) => (
        <Link key={service[0]} href={`/${locale}/services/${serviceSlugs[index]}`}>
          <small>{String(index + 1).padStart(2, '0')}</small><h3>{service[0]}</h3><p>{service[1]}</p><b>↗</b>
        </Link>
      ))}</div>
    </section>
    <section className="method-section">
      <div className="method-art"><div className="method-core">AI</div><span>HUMAN<br />JUDGMENT</span></div>
      <div><p className="kicker">02 / OUR METHOD</p><h2>{copy.methodTitle.split('\n').map((line) => <span key={line}>{line}</span>)}</h2><p>{copy.methodText}</p>
        <div className="metrics">{copy.metrics.map((metric) => <div key={metric[1]}><strong>{metric[0]}</strong><span>{metric[1]}</span></div>)}</div>
      </div>
    </section>
    <section className="cases-section">
      <div className="section-heading light"><p>03 / SELECTED WORK</p><h2>{copy.casesTitle}</h2></div>
      <div className="case-list">{copy.cases.map((item, index) => <article key={item[0]}>
        <span>0{index + 1}</span><div><h3>{item[0]}</h3><p>{item[1]}</p></div><strong>{item[2]}<small>{item[3]}</small></strong>
      </article>)}</div>
    </section>
    <section className="process-section"><p className="kicker">04 / PROCESS</p><h2>{copy.processTitle}</h2>
      <div className="process-grid">{copy.process.map((item) => <div key={item[0]}><span>{item[0]}</span><strong>{item[1]}</strong></div>)}</div>
    </section>
    <section className="final-cta"><p>LET’S BUILD WHAT’S NEXT</p><h2>{copy.finalTitle}</h2><span>{copy.finalText}</span><Link href={`/${locale}/contact`}>{copy.contact} ↗</Link></section>
  </>;
}

function EditorialPage({ locale, slug }: { readonly locale: Locale; readonly slug: string[] }) {
  const title = routeTitle(locale, slug);
  const copy = dictionary(locale);
  const serviceIndex = slug[0] === 'services' ? serviceSlugs.indexOf(slug[1] as typeof serviceSlugs[number]) : -1;
  const service = serviceIndex >= 0 ? copy.services[serviceIndex] : null;
  const descriptions: Record<string, readonly [string, string]> = {
    creators: ['从内容策略到商业履约，建立属于创作者的专业经营系统。', 'A professional operating system around your creative ambition.'],
    brands: ['用更准确的创作者匹配、更透明的履约流程，完成真正有效的内容合作。', 'Creator partnerships with sharper matching, accountable delivery and measurable learning.'],
    cases: ['我们关心的不只是漂亮结果，更是结果背后可持续的方法。', 'We care about beautiful outcomes—and the repeatable systems behind them.'],
    insights: ['关于创作者经济、AI 内容生产与品牌增长的实践观察。', 'Practical perspectives on the creator economy, AI-enabled production and brand growth.'],
    about: ['我们是一支站在创作者身后的专业团队。', 'We are the expert team behind ambitious creators.'],
    privacy: ['我们只收集提供服务所必需的信息，并以明确目的处理。', 'We only collect information necessary to provide our services.'],
    cookies: ['非必要分析与营销 Cookie 仅在取得同意后启用。', 'Non-essential analytics and marketing cookies require consent.'],
    terms: ['具体服务范围、交付与责任以双方正式合同约定为准。', 'Specific scope, delivery and responsibilities are governed by signed agreements.'],
  };
  const description = service?.[1] ?? descriptions[slug[0] ?? 'about']?.[locale === 'zh-CN' ? 0 : 1] ?? '';
  return <section className="editorial-page">
    <p className="kicker">GAOQ / {String(slug[0] ?? '').toUpperCase()}</p>
    <h1>{service?.[0] ?? title}</h1><p className="editorial-intro">{description}</p>
    <div className="editorial-panel"><span>01</span><h2>{locale === 'zh-CN' ? '专业判断与 AI 效率协同' : 'Expert judgment, amplified by AI'}</h2>
      <p>{locale === 'zh-CN' ? '每一项服务都有清晰的责任人、交付标准和复盘机制。AI 提高速度，专业人员对质量与结果负责。' : 'Every engagement has clear ownership, delivery standards and review. AI improves speed; specialists remain accountable for quality.'}</p>
    </div>
    <Link className="editorial-cta" href={`/${locale}/contact`}>{copy.contact} ↗</Link>
  </section>;
}

function validPath(slug: readonly string[]): boolean {
  if (slug.length === 0) return true;
  const single = new Set(['creators', 'brands', 'cases', 'insights', 'about', 'contact', 'privacy', 'cookies', 'terms']);
  return (slug.length === 1 && single.has(slug[0] ?? '')) ||
    (slug.length === 2 && ['cases', 'insights'].includes(slug[0] ?? '') &&
      /^(?:[a-z0-9]+(?:-[a-z0-9]+)*)$/u.test(slug[1] ?? '')) ||
    (slug.length === 2 && slug[0] === 'services' && serviceSlugs.includes(slug[1] as typeof serviceSlugs[number]));
}
