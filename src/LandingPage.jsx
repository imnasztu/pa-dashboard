import { useState, useEffect, useRef, useCallback } from 'react';
import './landing.css';

// ══════════════════════════════════════
// DATA
// ══════════════════════════════════════
const FEATURED = {
  id: 0,
  title: 'E-Commerce Superapp',
  category: 'Mobile UX · Web Design',
  desc: 'End-to-end redesign of a multi-platform shopping experience. Increased conversion by 38% through user-centered flows.',
  tags: ['User Research', 'Figma', 'Prototyping', 'Design System'],
  year: '2024',
  icon: '🛍',
  color: '#FFD93D',
};

const PROJECTS = [
  { id: 1, title: 'SaaS Analytics Dashboard', category: 'Web Design', year: '2024', color: '#4ECDC4', icon: '📊' },
  { id: 2, title: 'Brand Identity System', category: 'Visual Design', year: '2023', color: '#FF6B6B', icon: '✦' },
  { id: 3, title: 'Food Delivery Experience', category: 'Mobile UX', year: '2023', color: '#C589E8', icon: '🍜' },
  { id: 4, title: 'FinTech Mobile App', category: 'UI Design', year: '2024', color: '#A8E6CF', icon: '💳' },
  { id: 5, title: 'Design System Library', category: 'Design Systems', year: '2024', color: '#FFB347', icon: '⬡' },
];

const SKILLS = [
  { name: 'Figma',              rot: '-2deg' },
  { name: 'User Research',      rot: '1.5deg' },
  { name: 'Prototyping',        rot: '-1deg' },
  { name: 'Wireframing',        rot: '2deg' },
  { name: 'Design Systems',     rot: '-1.5deg' },
  { name: 'UX Writing',         rot: '1deg' },
  { name: 'Usability Testing',  rot: '-2.5deg' },
  { name: 'Adobe XD',           rot: '2deg' },
  { name: 'Illustrator',        rot: '-1deg' },
  { name: 'After Effects',      rot: '1.5deg' },
  { name: 'HTML / CSS',         rot: '-2deg' },
  { name: 'Interaction Design', rot: '1deg' },
];

const MARQUEE_ITEMS = [
  'UX Design', 'UI Design', 'Prototyping', 'User Research',
  'Design Systems', 'Mobile Apps', 'Web Design', 'Branding',
];

// ══════════════════════════════════════
// DOODLE SVG COMPONENTS
// ══════════════════════════════════════
function DoodleStar({ size = 40, color = '#FFD93D', style }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" style={style} aria-hidden>
      <path
        d="M20 3L23.5 15.5L36 12.5L26.5 21.5L35.5 31L23 27.5L20 39L17 27.5L4.5 31L13.5 21.5L4 12.5L16.5 15.5Z"
        fill={color} stroke="#1A1A1A" strokeWidth="2.2" strokeLinejoin="round"
      />
    </svg>
  );
}

function DoodleCircle({ size = 64, color = '#4ECDC4', style }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" style={style} aria-hidden>
      <circle cx="32" cy="32" r="26" fill={color} stroke="#1A1A1A" strokeWidth="2.5"/>
      <circle cx="32" cy="32" r="18" fill="none" stroke="#1A1A1A" strokeWidth="1.5" strokeDasharray="3 5"/>
    </svg>
  );
}

function DoodleSquiggle({ width = 100, color = '#FF6B6B', style }) {
  const pts = Math.floor(width / 14);
  const d = `M0,12 ${Array.from({ length: pts }, (_, i) =>
    `Q${(i + 0.5) * 14},${i % 2 === 0 ? 1 : 23} ${(i + 1) * 14},12`
  ).join(' ')}`;
  return (
    <svg width={width} height="24" viewBox={`0 0 ${width} 24`} style={style} aria-hidden>
      <path d={d} fill="none" stroke={color} strokeWidth="3" strokeLinecap="round"/>
    </svg>
  );
}

function DoodlePlus({ size = 32, color = '#1A1A1A', style }) {
  const h = size / 2, q = size / 4, t = (3 * size) / 4;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={style} aria-hidden>
      <line x1={h} y1={q} x2={h} y2={t} stroke={color} strokeWidth="3.5" strokeLinecap="round"/>
      <line x1={q} y1={h} x2={t} y2={h} stroke={color} strokeWidth="3.5" strokeLinecap="round"/>
    </svg>
  );
}

function DoodleArrow({ width = 80, style }) {
  return (
    <svg width={width} height="40" viewBox="0 0 80 40" style={style} aria-hidden>
      <path d="M5 22 C16 6, 32 6, 42 21 C52 36, 67 36, 74 22"
        fill="none" stroke="#1A1A1A" strokeWidth="2.8" strokeLinecap="round"/>
      <path d="M67 15 L74 22 L67 29"
        fill="none" stroke="#1A1A1A" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

// ══════════════════════════════════════
// FEATURED CARD (full-width banner)
// ══════════════════════════════════════
function FeaturedCard({ project }) {
  const ref = useRef(null);
  const [tilt, setTilt] = useState({ x: 0, y: 0 });
  const [hovered, setHovered] = useState(false);

  const onMove = useCallback((e) => {
    if (!ref.current) return;
    const r = ref.current.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width - 0.5;
    const y = (e.clientY - r.top) / r.height - 0.5;
    setTilt({ x: y * -8, y: x * 8 });
  }, []);

  return (
    <div className="work-featured">
      <div
        ref={ref}
        className="featured-card"
        style={{
          transform: `perspective(900px) rotateX(${tilt.x}deg) rotateY(${tilt.y}deg)${hovered ? ' scale(1.01)' : ''}`,
          transition: hovered ? 'transform 0.06s ease-out' : 'transform 0.4s ease-out',
        }}
        onMouseMove={onMove}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => { setHovered(false); setTilt({ x: 0, y: 0 }); }}
      >
        <div className="featured-thumb" style={{ background: project.color }}>
          <span style={{ fontSize: 100, position: 'relative', zIndex: 1 }}>{project.icon}</span>
        </div>
        <div className="featured-info">
          <div className="feat-eyebrow">{project.category} · {project.year}</div>
          <div className="feat-title">{project.title}</div>
          <div className="feat-desc">{project.desc}</div>
          <div className="feat-tags">
            {project.tags.map(t => <span key={t} className="feat-tag">{t}</span>)}
          </div>
          <div className="feat-arrow">→</div>
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════
// PROJECT CARD (3D tilt on hover)
// ══════════════════════════════════════
function ProjectCard({ project, index }) {
  const ref = useRef(null);
  const [tilt, setTilt] = useState({ x: 0, y: 0 });
  const [hovered, setHovered] = useState(false);

  const onMove = useCallback((e) => {
    if (!ref.current) return;
    const r = ref.current.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width - 0.5;
    const y = (e.clientY - r.top) / r.height - 0.5;
    setTilt({ x: y * -16, y: x * 16 });
  }, []);

  return (
    <div
      ref={ref}
      className="project-card-3d"
      onMouseMove={onMove}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => { setHovered(false); setTilt({ x: 0, y: 0 }); }}
    >
      <div
        className="pcard-inner"
        style={{
          transform: `perspective(700px) rotateX(${tilt.x}deg) rotateY(${tilt.y}deg)${hovered ? ' scale(1.025)' : ''}`,
          transition: hovered ? 'transform 0.06s ease-out' : 'transform 0.35s ease-out',
        }}
      >
        <div className="pcard-thumb" style={{ background: project.color }}>
          <span className="pcard-icon">{project.icon}</span>
        </div>
        <div className="pcard-body">
          <div className="pcard-cat">{project.category}</div>
          <div className="pcard-title">{project.title}</div>
          <div className="pcard-footer">
            <span className="pcard-year">{project.year}</span>
            <div className="pcard-arrow">→</div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════
// MAIN LANDING PAGE
// ══════════════════════════════════════
export default function LandingPage({ onDashboard }) {
  const heroRef = useRef(null);
  const [heroTilt, setHeroTilt] = useState({ x: 0, y: 0 });

  const onHeroMove = useCallback((e) => {
    if (!heroRef.current) return;
    const r = heroRef.current.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width - 0.5;
    const y = (e.clientY - r.top) / r.height - 0.5;
    setHeroTilt({ x: y * -12, y: x * 12 });
  }, []);

  return (
    <div className="landing-root">

      {/* ── NAV ── */}
      <nav className="l-nav">
        <a className="l-nav-logo" href="#">na<span>.</span>studio</a>
        <ul className="l-nav-links">
          <li><a href="#work">Work</a></li>
          <li><a href="#about">About</a></li>
          <li><a href="#contact">Contact</a></li>
        </ul>
        <button className="l-nav-cta" onClick={onDashboard}>Dashboard →</button>
      </nav>

      {/* ═══════════════════════════════
          HERO — full page
      ═══════════════════════════════ */}
      <section
        ref={heroRef}
        className="hero-section"
        onMouseMove={onHeroMove}
        onMouseLeave={() => setHeroTilt({ x: 0, y: 0 })}
      >
        <div className="hero-bg-pattern" />

        {/* Floating doodle decorations */}
        <div className="doodle-float" style={{ top: '16%', left: '6%' }}>
          <DoodleStar size={52} color="#FFD93D" style={{
            display: 'block',
            animation: 'doodle-bob 3.6s ease-in-out infinite',
            '--base-t': 'rotate(-12deg)',
            transform: 'rotate(-12deg)',
          }}/>
        </div>
        <div className="doodle-float" style={{ top: '12%', right: '10%' }}>
          <DoodleCircle size={84} color="#4ECDC4" style={{
            display: 'block',
            animation: 'doodle-bob 4.2s ease-in-out infinite 0.4s',
          }}/>
        </div>
        <div className="doodle-float" style={{ bottom: '28%', left: '9%' }}>
          <DoodlePlus size={38} style={{
            display: 'block',
            animation: 'doodle-bob 3.1s ease-in-out infinite 1s',
            '--base-t': 'rotate(18deg)',
            transform: 'rotate(18deg)',
          }}/>
        </div>
        <div className="doodle-float" style={{ bottom: '22%', right: '14%' }}>
          <DoodleStar size={34} color="#C589E8" style={{
            display: 'block',
            animation: 'doodle-bob 4.8s ease-in-out infinite 0.8s',
            '--base-t': 'rotate(6deg)',
            transform: 'rotate(6deg)',
          }}/>
        </div>
        <div className="doodle-float" style={{ top: '42%', left: '3%' }}>
          <DoodleSquiggle width={110} color="#FF6B6B" style={{
            display: 'block',
            animation: 'doodle-bob 5s ease-in-out infinite 0.2s',
            '--base-t': 'rotate(-8deg)',
            transform: 'rotate(-8deg)',
          }}/>
        </div>
        <div className="doodle-float" style={{ top: '55%', right: '5%' }}>
          <DoodleArrow style={{
            display: 'block',
            animation: 'doodle-bob 3.9s ease-in-out infinite 1.3s',
            '--base-t': 'rotate(12deg)',
            transform: 'rotate(12deg)',
          }}/>
        </div>
        <div className="doodle-float" style={{ top: '72%', left: '18%' }}>
          <DoodlePlus size={26} color="#FFD93D" style={{
            display: 'block',
            animation: 'doodle-bob 3.4s ease-in-out infinite 0.6s',
            '--base-t': 'rotate(-22deg)',
            transform: 'rotate(-22deg)',
          }}/>
        </div>

        <div className="hero-inner">
          {/* Left: Text */}
          <div className="hero-text">
            <div className="hero-badge">Available for work</div>
            <h1 className="hero-h1">
              Crafting<br/>
              <span className="sketch-word">Digital Magic</span>
              for brands
            </h1>
            <p className="hero-desc">
              UX/UI Designer with 5+ years turning complex problems into
              clean, delightful digital experiences — from mobile apps to
              full design systems.
            </p>
            <div className="hero-btns">
              <a href="#work" className="btn-dark">View My Work ↓</a>
              <a href="#contact" className="btn-yellow">Let's Talk ✦</a>
            </div>
          </div>

          {/* Right: 3D Card */}
          <div className="hero-card-3d">
            <div
              className="hero-card-scene"
              style={{
                transform: `perspective(900px) rotateX(${heroTilt.x}deg) rotateY(${heroTilt.y}deg)`,
                transition: 'transform 0.08s ease-out',
              }}
            >
              <div className="hero-card-face">
                <div className="hcf-bg-blob" />
                <div className="hcf-bg-blob2" />
                <div className="hcf-deco-star">
                  <DoodleStar size={44} color="#FFD93D" />
                </div>
                <div className="hcf-tag">✦ UX / UI Designer</div>
                <div className="hcf-avatar">🎨</div>
                <div className="hcf-name">Nasztu</div>
                <div className="hcf-role">Crafting pixel-perfect experiences</div>
                <div className="hcf-stats">
                  <div className="hcf-stat">
                    <span className="hcf-stat-num">50+</span>
                    <span className="hcf-stat-lbl">Projects</span>
                  </div>
                  <div className="hcf-stat">
                    <span className="hcf-stat-num">5yr</span>
                    <span className="hcf-stat-lbl">Experience</span>
                  </div>
                  <div className="hcf-stat">
                    <span className="hcf-stat-num">30+</span>
                    <span className="hcf-stat-lbl">Clients</span>
                  </div>
                </div>
                <div className="hcf-squiggle">
                  <DoodleSquiggle width={100} color="#4ECDC4" />
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="scroll-hint">
          <span>Scroll</span>
          <span>↓</span>
        </div>
      </section>

      {/* ═══════════════════════════════
          WORK — full page banner
      ═══════════════════════════════ */}
      <section className="work-section" id="work">
        <div className="work-bg-dots" />

        <div className="work-header">
          <div>
            <p className="work-eyebrow">— Selected Works</p>
            <h2 className="work-title">
              What I've
              <span>Built</span>
            </h2>
          </div>
          <div className="work-meta">
            <span className="work-count">6 projects</span>
            <DoodleArrow style={{ transform: 'rotate(-15deg) scaleX(-1)', opacity: 0.4 }} />
          </div>
        </div>

        {/* Full-width featured card */}
        <FeaturedCard project={FEATURED} />

        {/* 3-column grid */}
        <div className="work-grid">
          {PROJECTS.map((p, i) => (
            <ProjectCard key={p.id} project={p} index={i} />
          ))}
        </div>

        {/* Marquee ticker */}
        <div className="work-marquee-wrap">
          <div className="work-marquee">
            {[...MARQUEE_ITEMS, ...MARQUEE_ITEMS].map((t, i) => (
              <span key={i} className="marquee-item">{t} ✦</span>
            ))}
          </div>
        </div>
      </section>

      {/* ═══════════════════════════════
          ABOUT
      ═══════════════════════════════ */}
      <section className="about-section" id="about">
        <div className="about-inner">
          {/* Doodle card */}
          <div className="about-card-wrap">
            <div className="about-star-deco">
              <DoodleStar size={52} color="#FFD93D" />
            </div>
            <div className="about-doodle-card">
              <div className="about-img">🎨</div>
              <div className="about-card-name">Nasztu</div>
              <div className="about-card-sub">UX/UI Designer & Creative</div>
              <div className="about-card-loc">📍 Based in Thailand 🇹🇭</div>
            </div>
          </div>

          {/* Text */}
          <div className="about-text">
            <h2>
              Hello,<br />
              I'm <span>Nasztu</span>
            </h2>
            <p>
              A passionate UX/UI Designer who loves creating clean, intuitive,
              and visually stunning digital experiences. I believe great design
              solves real problems while making people smile.
            </p>
            <p>
              I specialize in mobile app design, SaaS products, and brand identity —
              bringing ideas from rough sketches to pixel-perfect deliverables.
            </p>
            <div className="about-tags">
              {['Problem Solver', 'Detail-Oriented', 'User-Focused', 'Creative Thinker', 'Team Player'].map(t => (
                <span key={t} className="about-tag">{t}</span>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ═══════════════════════════════
          SKILLS
      ═══════════════════════════════ */}
      <section className="skills-section">
        <div className="skills-inner">
          <h2>Tools &amp; <span>Skills</span></h2>
          <p className="skills-sub">Everything I use to bring ideas to life</p>
          <div className="skills-list">
            {SKILLS.map(s => (
              <div key={s.name} className="skill-chip" style={{ '--rot': s.rot }}>
                {s.name}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ═══════════════════════════════
          CONTACT
      ═══════════════════════════════ */}
      <section className="contact-section" id="contact">
        <div className="contact-inner">
          <DoodleStar size={60} color="#FFD93D" style={{ display: 'block', margin: '0 auto 28px', animation: 'spin-slow 8s linear infinite' }} />
          <h2>
            Let's Work<br />
            <span>Together</span>
          </h2>
          <p>
            Have a project in mind? I'd love to hear about it and explore how
            we can create something amazing together.
          </p>
          <div className="contact-links">
            <a href="mailto:hello@nasztu.com" className="contact-link primary">✉ Send Email</a>
            <a href="#" className="contact-link">↗ Behance</a>
            <a href="#" className="contact-link">↗ LinkedIn</a>
            <a href="#" className="contact-link">↗ Dribbble</a>
          </div>
        </div>

        <div className="footer-bar">
          <span className="footer-copy">© 2024 Nasztu. All rights reserved.</span>
          <DoodleSquiggle width={80} color="#ccc" />
          <span className="footer-made">Made with ♥ &amp; lots of coffee</span>
        </div>
      </section>

    </div>
  );
}
