module.exports = `
  <header>
    <div class="logo-block">
      <div class="logo">Cursor Guild Judge Portal</div>
      <div class="meta">Score projects on the 7 + 3 = 10 model</div>
    </div>
    <div class="header-links">
      <a class="board-link" href="/">Hack Board</a>
      <a class="board-link" href="/admin">Hack Manager</a>
    </div>
  </header>

  <main class="judge-main">
    <section class="judge-shell">
      <section class="judge-stage panel">
        <div class="judge-stage-top">
          <button id="prev-submission" class="nav-button" type="button" aria-label="Previous submission">&larr;</button>
          <div>
            <div id="submission-position" class="submission-position">0 / 0</div>
            <h2 id="submission-title">Loading submissions...</h2>
            <div id="submission-meta" class="submission-meta"></div>
          </div>
          <button id="next-submission" class="nav-button" type="button" aria-label="Next submission">&rarr;</button>
        </div>

        <div class="submission-card" id="submission-card">
          <div class="submission-card-face submission-card-face--front">
            <button id="flip-details" class="info-button" type="button">More info</button>
            <div id="demo-panel" class="demo-panel"></div>
          </div>
          <div class="submission-card-face submission-card-face--back">
            <button id="flip-back" class="info-button" type="button">Back to demo</button>
            <div id="detail-panel" class="detail-panel"></div>
          </div>
        </div>

        <div class="judge-stage-footer">
          <button id="prev-submission-bottom" class="action-button action-button--secondary" type="button">Previous</button>
          <button id="next-submission-bottom" class="action-button action-button--secondary" type="button">Next</button>
        </div>
      </section>

      <aside class="judge-sidebar">
        <section class="panel judge-panel">
          <h3>Judge</h3>
          <p id="judge-display-name" class="judge-session-banner" aria-live="polite"></p>
        </section>

        <section class="panel judge-panel rubric-panel">
          <h3>Rubric Reminder</h3>
          <div id="rubric-summary" class="rubric-summary"></div>
        </section>

        <section class="panel judge-panel">
          <h3>Score This Project</h3>
          <div class="score-section-title">Core: 7 points</div>
          <div id="core-fields" class="score-fields"></div>
          <div class="score-section-title">Bonus: 3 points</div>
          <div id="bonus-fields" class="score-fields"></div>
          <label class="field">
            <span>Optional Notes</span>
            <textarea id="judge-notes" rows="4" placeholder="Short note for tie-breaks or organizer context"></textarea>
          </label>
          <div id="totals-output" class="totals-output">Core 0/7 &bull; Bonus 0/3 &bull; Total 0/10</div>
          <button id="submit-score" class="action-button" type="button">Save Score</button>
          <div id="submit-status" class="status-text"></div>
        </section>

        <section class="panel judge-panel">
          <h3>Scoring Queue</h3>
          <div id="score-queue" class="score-queue"></div>
        </section>
      </aside>
    </section>
  </main>
`;
