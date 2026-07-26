'use client';

import {
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from 'react';

import type {
  CareerApplicationResponse,
  CareerPosition,
  CareerPositionsResponse,
} from './career-types';

const ALL = '全部团队';

export function CareerPortal() {
  const [positions, setPositions] = useState<readonly CareerPosition[]>([]);
  const [source, setSource] = useState<'erp' | 'preview'>('erp');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [department, setDepartment] = useState(ALL);
  const [keyword, setKeyword] = useState('');
  const [selected, setSelected] = useState<CareerPosition | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    let active = true;
    fetch('/api/careers/jobs', { cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) throw new Error('CAREERS_UNAVAILABLE');
        return response.json() as Promise<CareerPositionsResponse>;
      })
      .then((result) => {
        if (!active) return;
        setPositions(result.positions);
        setSource(result.source);
        setLoadError(false);
      })
      .catch(() => {
        if (active) setLoadError(true);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const departments = useMemo(
    () => [ALL, ...new Set(positions.map((position) => position.department))],
    [positions],
  );
  const filtered = useMemo(() => {
    const query = keyword.trim().toLocaleLowerCase('zh-CN');
    return positions.filter((position) =>
      (department === ALL || position.department === department) &&
      (query.length === 0 || [
        position.title,
        position.department,
        position.location,
      ].some((value) => value.toLocaleLowerCase('zh-CN').includes(query))),
    );
  }, [department, keyword, positions]);

  return (
    <main className="career-site">
      <header className="career-nav">
        <a className="career-logo" href="#top" aria-label="告趣招聘首页">
          <span className="career-logo-mark" aria-hidden="true">G</span>
          <span><strong>告趣</strong><small>GAOQ GROUP</small></span>
        </a>
        <button
          className="career-menu-button"
          type="button"
          aria-label="切换导航"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((value) => !value)}
        >
          <span /><span />
        </button>
        <nav className={menuOpen ? 'career-links is-open' : 'career-links'} aria-label="招聘导航">
          <a href="#about" onClick={() => setMenuOpen(false)}>认识告趣</a>
          <a href="#culture" onClick={() => setMenuOpen(false)}>在这里工作</a>
          <a href="#positions" onClick={() => setMenuOpen(false)}>开放职位</a>
          <a className="career-nav-cta" href="#positions" onClick={() => setMenuOpen(false)}>
            找到你的角色 <ArrowIcon />
          </a>
        </nav>
      </header>

      <section className="career-hero" id="top">
        <div className="career-hero-copy">
          <p className="career-kicker"><span /> WE ARE GAOQ</p>
          <h1>把热爱，<br />做成<span>影响力。</span></h1>
          <p className="career-hero-summary">
            我们连接内容、品牌与技术，让每个好想法被看见。
            和一群有趣、坦诚、相信长期主义的人，一起创造下一件值得骄傲的事。
          </p>
          <div className="career-hero-actions">
            <a href="#positions">查看开放职位 <ArrowIcon /></a>
            <a href="#about">了解我们 <PlayIcon /></a>
          </div>
        </div>
        <div className="career-orbit" aria-label="连接内容、品牌与技术的视觉图形">
          <div className="career-orbit-ring ring-one" />
          <div className="career-orbit-ring ring-two" />
          <div className="career-orbit-core">
            <span>一起</span>
            <strong>GO</strong>
            <small>FURTHER</small>
          </div>
          <span className="career-orbit-tag tag-content">内容 CONTENT</span>
          <span className="career-orbit-tag tag-brand">品牌 BRAND</span>
          <span className="career-orbit-tag tag-tech">技术 TECH</span>
          <span className="career-orbit-dot dot-one" />
          <span className="career-orbit-dot dot-two" />
        </div>
        <div className="career-scroll-note"><span /> SCROLL TO EXPLORE</div>
      </section>

      <section className="career-intro" id="about">
        <div>
          <p className="career-section-label">01 / ABOUT US</p>
          <h2>保持好奇，<br />保持告趣。</h2>
        </div>
        <div className="career-intro-copy">
          <p>
            告趣是一家以内容为原点的创新企业。我们尊重专业，也珍惜灵感；
            关注结果，也在意抵达结果的方式。
          </p>
          <p>
            在这里，边界是用来探索的，问题是用来解决的，而每个人都能成为新故事的发起者。
          </p>
          <div className="career-stats" aria-label="团队数据">
            <div><strong>10+</strong><span>业务场景</span></div>
            <div><strong>∞</strong><span>成长可能</span></div>
            <div><strong>1</strong><span>共同目标</span></div>
          </div>
        </div>
      </section>

      <section className="career-culture" id="culture">
        <div className="career-section-heading">
          <p className="career-section-label">02 / LIFE AT GAOQ</p>
          <h2>好的工作，<br />应该让人<span>发光。</span></h2>
        </div>
        <div className="career-values">
          <article className="career-value-card is-dark">
            <span className="career-value-index">01</span>
            <div className="career-value-symbol">↗</div>
            <h3>主动向前</h3>
            <p>不等完美答案，先迈出有判断的一步。让行动带来新的信息。</p>
          </article>
          <article className="career-value-card is-cyan">
            <span className="career-value-index">02</span>
            <div className="career-value-symbol">◎</div>
            <h3>坦诚协作</h3>
            <p>把问题放在桌面上，把信任留给彼此。复杂的事一起做简单。</p>
          </article>
          <article className="career-value-card is-light">
            <span className="career-value-index">03</span>
            <div className="career-value-symbol">✦</div>
            <h3>创造惊喜</h3>
            <p>多想半步，多做一点。我们相信好体验来自持续的在意。</p>
          </article>
        </div>
      </section>

      <section className="career-jobs" id="positions">
        <div className="career-jobs-heading">
          <div>
            <p className="career-section-label">03 / OPEN POSITIONS</p>
            <h2>下一位伙伴，<br />会是你吗？</h2>
          </div>
          <p>找到与你的热爱、经验和想象力相遇的位置。</p>
        </div>

        {source === 'preview' ? (
          <p className="career-preview-note">
            当前为开发预览数据；配置门户服务身份后将自动读取 ERP 已开放职位。
          </p>
        ) : null}

        <div className="career-job-browser">
          <div className="career-job-filters">
            <label className="career-search">
              <SearchIcon />
              <span className="sr-only">搜索职位</span>
              <input
                value={keyword}
                onChange={(event) => setKeyword(event.target.value)}
                placeholder="搜索职位、团队或城市"
              />
            </label>
            <div className="career-departments" role="group" aria-label="按团队筛选">
              {departments.map((item) => (
                <button
                  type="button"
                  key={item}
                  className={department === item ? 'is-active' : ''}
                  onClick={() => setDepartment(item)}
                >
                  {item}
                </button>
              ))}
            </div>
          </div>

          <div className="career-job-list" aria-live="polite">
            {loading ? <CareerLoading /> : null}
            {loadError ? (
              <div className="career-empty">
                <strong>职位正在赶来的路上</strong>
                <span>职位服务暂时不可用，请稍后刷新页面。</span>
              </div>
            ) : null}
            {!loading && !loadError && filtered.length === 0 ? (
              <div className="career-empty">
                <strong>暂时没有匹配的职位</strong>
                <span>换个关键词看看，或者过几天再来。</span>
              </div>
            ) : null}
            {filtered.map((position, index) => (
              <button
                type="button"
                className="career-job-row"
                key={position.id}
                onClick={() => setSelected(position)}
              >
                <span className="career-job-number">{String(index + 1).padStart(2, '0')}</span>
                <span className="career-job-main">
                  <strong>{position.title}</strong>
                  <small>{position.department}</small>
                </span>
                <span className="career-job-meta">
                  <span><PinIcon /> {position.location}</span>
                  <span>{position.headcount} 个名额</span>
                </span>
                <span className="career-job-arrow"><ArrowIcon /></span>
              </button>
            ))}
          </div>
        </div>
      </section>

      <section className="career-process">
        <p className="career-section-label">04 / HOW WE HIRE</p>
        <div className="career-process-heading">
          <h2>真诚相遇，<br />双向选择。</h2>
          <p>我们会认真阅读每一份申请，也希望每一次交流都让彼此更了解。</p>
        </div>
        <ol>
          <li><span>01</span><strong>提交申请</strong><small>选择职位，留下你的基本信息</small></li>
          <li><span>02</span><strong>初步沟通</strong><small>招聘伙伴与你确认彼此期待</small></li>
          <li><span>03</span><strong>专业面谈</strong><small>与未来伙伴聊经历、能力和想法</small></li>
          <li><span>04</span><strong>欢迎加入</strong><small>Offer 确认后开启新的旅程</small></li>
        </ol>
      </section>

      <section className="career-final-cta">
        <p>DO SOMETHING GREAT, TOGETHER.</p>
        <h2>故事正在发生。<br /><span>等你来续写。</span></h2>
        <a href="#positions">探索开放职位 <ArrowIcon /></a>
      </section>

      <footer className="career-footer">
        <a className="career-logo is-footer" href="#top">
          <span className="career-logo-mark">G</span>
          <span><strong>告趣</strong><small>GAOQ GROUP</small></span>
        </a>
        <p>让有趣的事，产生长久的影响。</p>
        <div><a href="#about">认识告趣</a><a href="#culture">团队文化</a><a href="#positions">开放职位</a></div>
        <small>© {new Date().getFullYear()} GaoQ Group. All rights reserved.</small>
      </footer>

      {selected !== null ? (
        <ApplicationDialog
          position={selected}
          preview={source === 'preview'}
          onClose={() => setSelected(null)}
        />
      ) : null}
    </main>
  );
}

function ApplicationDialog({
  position,
  preview,
  onClose,
}: {
  readonly position: CareerPosition;
  readonly preview: boolean;
  readonly onClose: () => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<CareerApplicationResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.body.classList.add('career-modal-open');
    window.addEventListener('keydown', listener);
    return () => {
      document.body.classList.remove('career-modal-open');
      window.removeEventListener('keydown', listener);
    };
  }, [onClose]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const rawPhone = formText(form, 'phone').replace(/[\s()-]/gu, '');
    const phone = /^1[3-9][0-9]{9}$/u.test(rawPhone) ? `+86${rawPhone}` : rawPhone;
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch('/api/careers/applications', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          submissionId: crypto.randomUUID(),
          positionId: position.id,
          name: formText(form, 'name'),
          phone,
          email: formText(form, 'email'),
          submittedAt: new Date().toISOString(),
          consentAccepted: form.get('consent') === 'on',
          website: formText(form, 'website'),
        }),
      });
      const value = await response.json() as CareerApplicationResponse | {
        readonly message?: string;
      };
      if (!response.ok || !('applicationId' in value)) {
        throw new Error('message' in value ? value.message : '申请暂未提交成功');
      }
      setResult(value);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '申请暂未提交成功，请稍后再试');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="career-dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="career-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="career-dialog-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button type="button" className="career-dialog-close" onClick={onClose} aria-label="关闭">
          ×
        </button>
        {result === null ? (
          <>
            <div className="career-dialog-heading">
              <p>JOIN GAOQ</p>
              <h2 id="career-dialog-title">{position.title}</h2>
              <div><span>{position.department}</span><span>{position.location}</span></div>
            </div>
            <div className="career-dialog-layout">
              <div className="career-role-note">
                <p>我们期待这样的你</p>
                <ul>
                  <li>对所在领域保持好奇，愿意持续学习</li>
                  <li>能够清晰沟通，并对结果负责</li>
                  <li>尊重差异，乐于和伙伴共同解决问题</li>
                </ul>
                <small>招聘伙伴会在初步沟通中介绍更完整的岗位职责与任职要求。</small>
              </div>
              <form className="career-application-form" onSubmit={(event) => { void submit(event); }}>
                <label>姓名<input name="name" required maxLength={128} autoComplete="name" /></label>
                <label>手机<input name="phone" required placeholder="138 0000 0000" autoComplete="tel" /></label>
                <label>邮箱<input name="email" type="email" placeholder="name@example.com" autoComplete="email" /></label>
                <label className="career-honeypot" aria-hidden="true">
                  个人网站<input name="website" tabIndex={-1} autoComplete="off" />
                </label>
                <label className="career-consent">
                  <input name="consent" type="checkbox" required />
                  <span>
                    我已阅读并同意告趣为招聘甄选、候选人沟通及人才库管理处理上述信息，
                    授权有效期一年，最长保留两年。
                  </span>
                </label>
                {preview ? <p className="career-form-note">预览模式不会把本次申请写入 ERP。</p> : null}
                {error !== null ? <p className="career-form-error" role="alert">{error}</p> : null}
                <button type="submit" disabled={submitting}>
                  {submitting ? '正在提交…' : '提交申请'} <ArrowIcon />
                </button>
                <small>提交后将建立加密候选人档案，招聘进度以招聘伙伴通知为准。</small>
              </form>
            </div>
          </>
        ) : (
          <div className="career-success">
            <span>✓</span>
            <p>{result.preview ? 'PREVIEW COMPLETE' : 'APPLICATION RECEIVED'}</p>
            <h2>{result.preview ? '预览流程已完成' : '申请已收到，谢谢你。'}</h2>
            <p>
              {result.preview
                ? '服务身份配置完成后，申请会自动进入 ERP 候选人库。'
                : '招聘伙伴会认真阅读你的申请，如匹配会尽快与你联系。'}
            </p>
            <button type="button" onClick={onClose}>继续浏览职位</button>
          </div>
        )}
      </section>
    </div>
  );
}

function CareerLoading() {
  return (
    <div className="career-loading" aria-label="正在加载职位">
      <span /><span /><span />
    </div>
  );
}

function formText(form: FormData, field: string): string {
  const value = form.get(field);
  return typeof value === 'string' ? value : '';
}

function ArrowIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h13M13 6l6 6-6 6" /></svg>;
}

function PlayIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 7 8 5-8 5V7Z" /></svg>;
}

function SearchIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6" /><path d="m16 16 4 4" /></svg>;
}

function PinIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 10c0 5-7 11-7 11S5 15 5 10a7 7 0 1 1 14 0Z" /><circle cx="12" cy="10" r="2" /></svg>;
}
