process.env.SKIP_SLACK_VALIDATION = 'true';
process.env.STATE_DB_PATH = ':memory:';

import { liveProjectBoard } from '../src/projectBoard.js';

/** Read-only: confirms the bot can see your GitHub Project and how it maps Status / Priority. Writes nothing. */
liveProjectBoard
  .diagnose()
  .then(lines => {
    console.log('\n' + lines.join('\n') + '\n');
  })
  .catch(err => {
    console.error('\n✗ Could not read the project board:', err.message);
    console.error('  Check GITHUB_PROJECT_NUMBER, GITHUB_OWNER, and that GITHUB_TOKEN has the `project` scope.\n');
    process.exit(1);
  });
