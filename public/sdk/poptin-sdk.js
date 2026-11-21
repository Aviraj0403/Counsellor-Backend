(function () {
  const currentScript = document.currentScript;
  const tenantSlug = currentScript ? currentScript.getAttribute('data-tenant-slug') : null;
  const apiBase = currentScript ? (currentScript.getAttribute('data-api-base') || window.location.origin) : window.location.origin;

  if (!tenantSlug) {
    console.warn('[PoptinEngine] Missing data-tenant-slug on script tag');
    return;
  }

  const SESSION_KEY = `poptin_seen_${tenantSlug}`;
  if (sessionStorage.getItem(SESSION_KEY)) return;

  async function fetchConfig() {
    try {
      const res = await fetch(`${apiBase}/public/poptin/${tenantSlug}/config`);
      if (!res.ok) return;
      const data = await res.json();
      if (data && data.headline) {
        initTriggers(data);
      }
    } catch (e) {
      console.warn('[PoptinEngine] Failed to initialize popups', e);
    }
  }

  function initTriggers(config) {
    let triggered = false;

    function triggerModal() {
      if (triggered) return;
      triggered = true;
      renderModal(config);
      fetch(`${apiBase}/public/poptin/${tenantSlug}/impression`, { method: 'POST' }).catch(() => {});
    }

    // 1. Exit-Intent Trigger
    if (config.triggers && config.triggers.exitIntent !== false) {
      document.addEventListener('mouseleave', function (e) {
        if (e.clientY <= 15) triggerModal();
      });
    }

    // 2. Time Delay Trigger
    const delaySec = config.triggers?.timeDelaySeconds || 5;
    if (delaySec > 0) {
      setTimeout(triggerModal, delaySec * 1000);
    }

    // 3. Scroll Percentage Trigger
    const scrollTarget = config.triggers?.scrollPercentage || 40;
    if (scrollTarget > 0) {
      window.addEventListener('scroll', function () {
        const total = document.documentElement.scrollHeight - window.innerHeight;
        if (total > 0) {
          const currentPercent = (window.scrollY / total) * 100;
          if (currentPercent >= scrollTarget) triggerModal();
        }
      });
    }
  }

  function renderModal(c) {
    const design = c.design || {};
    const theme = design.themeColor || '#2563eb';
    const bg = design.backgroundColor || '#ffffff';
    const textColor = design.textColor || '#0f172a';
    const btnBg = design.buttonColor || theme;
    const btnText = design.buttonTextColor || '#ffffff';

    const overlay = document.createElement('div');
    overlay.id = 'cp-poptin-overlay';
    overlay.style = 'position:fixed;inset:0;background:rgba(15,23,42,0.65);backdrop-filter:blur(4px);display:flex;align-items:center;justify-content:center;z-index:999999;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;padding:16px;box-sizing:border-box;animation:cpFadeIn 0.2s ease-out;';

    overlay.innerHTML = `
      <style>
        @keyframes cpFadeIn { from { opacity: 0; } to { opacity: 1; } }
        @keyframes cpSlideUp { from { transform: translateY(20px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
        .cp-pop-box { box-sizing:border-box; animation: cpSlideUp 0.25s ease-out; }
        .cp-pop-box * { box-sizing:border-box; }
        .cp-pop-input { width:100%; padding:10px 14px; border:1px solid #cbd5e1; border-radius:8px; font-size:14px; color:#1e293b; outline:none; transition:border 0.2s; }
        .cp-pop-input:focus { border-color:${theme}; box-shadow:0 0 0 3px ${theme}22; }
      </style>
      <div class="cp-pop-box" style="background:${bg};color:${textColor};border-radius:16px;max-width:440px;width:100%;padding:28px 24px;position:relative;box-shadow:0 25px 50px -12px rgba(0,0,0,0.25);border:1px solid #e2e8f0;">
        <button id="cp-poptin-close" aria-label="Close" style="position:absolute;top:14px;right:14px;background:#f1f5f9;border:none;width:32px;height:32px;border-radius:50%;font-size:18px;line-height:1;display:flex;align-items:center;justify-content:center;cursor:pointer;color:#64748b;transition:background 0.2s;">&times;</button>
        <div style="display:inline-block;padding:4px 10px;background:${theme}15;color:${theme};font-size:11px;font-weight:700;text-transform:uppercase;border-radius:999px;margin-bottom:12px;letter-spacing:0.5px;">Admissions 2026 Guidance</div>
        <h3 style="margin:0 0 6px 0;font-size:20px;font-weight:800;line-height:1.3;color:${textColor};">${c.headline}</h3>
        <p style="margin:0 0 18px 0;font-size:13px;line-height:1.5;color:#64748b;">${c.subheadline || ''}</p>
        
        <form id="cp-poptin-form" style="display:flex;flex-direction:column;gap:10px;">
          <div>
            <input type="text" id="cp-poptin-name" placeholder="Student Full Name *" required class="cp-pop-input" />
          </div>
          <div>
            <input type="tel" id="cp-poptin-phone" placeholder="10-digit Mobile Number *" required pattern="[0-9]{10}" class="cp-pop-input" />
          </div>
          <div style="display:flex;gap:10px;">
            <input type="text" id="cp-poptin-course" placeholder="Interested Branch (e.g. CSE, IT)" class="cp-pop-input" style="flex:1;" />
            <input type="text" id="cp-poptin-city" placeholder="Your City" class="cp-pop-input" style="flex:1;" />
          </div>
          <button type="submit" id="cp-poptin-btn" style="background:${btnBg};color:${btnText};padding:12px;border:none;border-radius:8px;font-weight:700;font-size:14px;cursor:pointer;margin-top:6px;transition:opacity 0.2s;box-shadow:0 4px 12px ${btnBg}44;">
            ${design.buttonText || 'Get Free Counselling Call'}
          </button>
        </form>
        <div id="cp-poptin-msg" style="display:none;margin-top:16px;padding:12px;border-radius:8px;background:#ecfdf5;color:#065f46;font-size:14px;font-weight:600;text-align:center;"></div>
        <div style="margin-top:14px;font-size:11px;text-align:center;color:#94a3b8;">🔒 Safe & Verified • Expert counsellor will call within 15 minutes</div>
      </div>
    `;

    document.body.appendChild(overlay);

    const close = () => {
      sessionStorage.setItem(SESSION_KEY, '1');
      overlay.remove();
    };

    document.getElementById('cp-poptin-close').onclick = close;
    overlay.onclick = (e) => { if (e.target === overlay) close(); };

    document.getElementById('cp-poptin-form').onsubmit = async (e) => {
      e.preventDefault();
      const btn = document.getElementById('cp-poptin-btn');
      btn.disabled = true;
      btn.textContent = 'Submitting...';

      const name = document.getElementById('cp-poptin-name').value.trim();
      const phone = document.getElementById('cp-poptin-phone').value.trim();
      const interestedCourse = document.getElementById('cp-poptin-course').value.trim();
      const city = document.getElementById('cp-poptin-city').value.trim();

      try {
        const res = await fetch(`${apiBase}/public/poptin/${tenantSlug}/enquiry`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name,
            phone,
            interestedCourse: interestedCourse || undefined,
            city: city || undefined,
            sourceUrl: window.location.href,
          }),
        });

        const data = await res.json();
        if (res.ok) {
          document.getElementById('cp-poptin-form').style.display = 'none';
          const msg = document.getElementById('cp-poptin-msg');
          msg.textContent = '✓ Thank you! An admission counsellor has been assigned and will connect with you shortly.';
          msg.style.display = 'block';
          setTimeout(close, 3500);
        } else {
          alert(data.message || 'Please check the details entered.');
          btn.disabled = false;
          btn.textContent = design.buttonText || 'Get Free Counselling Call';
        }
      } catch (err) {
        alert('Network error. Please try again.');
        btn.disabled = false;
        btn.textContent = design.buttonText || 'Get Free Counselling Call';
      }
    };
  }

  fetchConfig();
})();

