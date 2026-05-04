module.exports = `
  <header>
    <div class="logo-block">
      <div class="logo">Cursor Guild Admin</div>
      <div class="meta">Submissions, judging, and repo analysis</div>
    </div>
    <div class="header-links">
      <a class="board-link" href="/">Hack Board</a>
      <a class="board-link" href="/judge">Judge Portal</a>
      <button class="board-link" id="open-demos-modal" type="button" style="cursor:pointer;background:none;border:1px solid #3dffa3;color:#3dffa3;padding:6px 12px;font-family:inherit;font-size:inherit;">DEMOS</button>
    </div>
  </header>

  <main>
    <section class="panel full-width">
      <div class="panel-header">
        <h2>Hackathon Manager</h2>
        <div class="stats-inline">
          <span class="stat-pill"><span id="stat-total">0</span> Submissions</span>
          <span class="stat-pill"><span id="stat-tracked">0</span> Tracked</span>
          <span class="stat-pill"><span id="stat-analyzed">0</span> Analyzed</span>
          <span class="stat-pill flagged"><span id="stat-flagged">0</span> Flagged</span>
          <span class="stat-pill clean"><span id="stat-clean">0</span> Clean</span>
          <span class="stat-pill"><span id="stat-commits">0</span> Commits</span>
        </div>
      </div>
      <div class="settings-strip">
        <div class="settings-copy">
          <div class="settings-title">Analysis Settings</div>
          <div class="settings-note">Persist the live hackathon timing and flag thresholds in Supabase so future submissions and batch reanalysis use the same rules.</div>
        </div>
        <form id="analysis-settings-form" class="settings-form">
          <label class="settings-field">
            <span>T0 Start</span>
            <input id="settings-event-t0" type="datetime-local" required>
          </label>
          <label class="settings-field">
            <span>T1 End</span>
            <input id="settings-event-t1" type="datetime-local" required>
          </label>
          <label class="settings-field">
            <span>Bulk LOC Threshold</span>
            <input id="settings-bulk-insertions" type="number" min="1" required>
          </label>
          <label class="settings-field">
            <span>Bulk Files Threshold</span>
            <input id="settings-bulk-files" type="number" min="1" required>
          </label>
          <label class="settings-field">
            <span>Max Commits</span>
            <input id="settings-max-commits" type="number" min="1" required>
          </label>
          <div class="settings-actions">
            <button id="save-analysis-settings" class="settings-button" type="submit">Save Settings</button>
            <button id="reanalyze-submissions" class="settings-button settings-button--secondary" type="button">Reanalyze Tracked Submissions</button>
          </div>
        </form>
        <div id="analysis-settings-status" class="settings-status"></div>
      </div>
      <div class="toolbar">
        <label><input type="checkbox" id="filter-preT0"> Pre-T0</label>
        <label><input type="checkbox" id="filter-bulk"> Bulk</label>
        <label><input type="checkbox" id="filter-merge"> Merge</label>
        <select id="sort-select">
          <option value="default">Default</option>
          <option value="judge">Judge Total</option>
          <option value="commits">Commits</option>
        </select>
      </div>
      <div class="table-wrapper">
        <table id="summary-table">
          <thead>
            <tr>
              <th class="th-repo">Submission</th>
              <th class="th-track">Track</th>
              <th class="th-status">Status</th>
              <th class="th-judge">Judge Total</th>
              <th class="th-num">Commits</th>
              <th class="th-num">LOC+</th>
              <th class="th-num">LOC-</th>
              <th class="th-flag">Pre-T0</th>
              <th class="th-flag">Bulk</th>
              <th class="th-flag">Init</th>
              <th class="th-flag">Merge</th>
              <th class="th-flag" title="Heuristic: repo text suggests Specter API/MCP">Specter</th>
              <th class="th-ai">AI Summary</th>
            </tr>
          </thead>
          <tbody></tbody>
        </table>
      </div>
    </section>

    <aside id="details-drawer" class="drawer hidden">
      <div class="drawer-header">
        <h2 id="detail-title">Repository Details</h2>
        <button id="close-drawer" class="close-btn" aria-label="Close">&times;</button>
      </div>
      <div class="drawer-content">
        <div class="section">
          <h3>Submission</h3>
          <div id="submission-output" class="box"></div>
        </div>
        <div class="section">
          <h3>Judge Responses</h3>
          <div id="judge-output" class="box"></div>
        </div>
        <div class="section">
          <h3>AI Analysis</h3>
          <div id="ai-output" class="box pre-wrap"></div>
        </div>
        <div class="metrics-grid">
          <div class="metric-card">
            <h4>Summary</h4>
            <pre id="metrics-summary"></pre>
          </div>
          <div class="metric-card">
            <h4>Flags</h4>
            <pre id="metrics-flags"></pre>
          </div>
          <div class="metric-card">
            <h4>Time Distribution</h4>
            <pre id="metrics-time"></pre>
          </div>
        </div>
        <div class="section">
          <h3>Commits <span class="commit-count"></span></h3>
          <div class="table-wrapper commits-table-wrapper">
            <table id="commits-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Time</th>
                  <th>+</th>
                  <th>-</th>
                  <th>Files</th>
                  <th>Bulk</th>
                  <th>&lt;T0</th>
                  <th>&gt;T1</th>
                  <th>Message</th>
                </tr>
              </thead>
              <tbody></tbody>
            </table>
          </div>
        </div>
      </div>
    </aside>
    <div id="drawer-overlay" class="drawer-overlay hidden"></div>
  </main>

  <div id="demos-modal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.85);z-index:3000;align-items:flex-start;justify-content:center;overflow-y:auto;padding:40px 20px;">
    <div style="width:min(900px,100%);background:#101010;border:3px solid #3dffa3;box-shadow:8px 8px 0 rgba(0,0,0,0.5);padding:24px;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:18px;">
        <h2 style="color:#3dffa3;font-size:0.8rem;margin:0;">ALL DEMOS</h2>
        <button id="close-demos-modal" style="background:none;border:2px solid #555;color:#ccc;padding:4px 12px;cursor:pointer;font-family:inherit;">CLOSE</button>
      </div>
      <div id="demos-list" style="display:flex;flex-direction:column;gap:12px;"></div>
    </div>
  </div>
`;
