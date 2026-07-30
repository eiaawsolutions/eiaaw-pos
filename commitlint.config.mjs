export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    // The default 100-char body limit forces commit messages that explain
    // nothing. Prose wrapped at a sane width is more useful than a terse
    // subject line, especially for the money-correctness commits.
    'body-max-line-length': [1, 'always', 100],
    'footer-max-line-length': [0],
    'subject-case': [2, 'never', ['start-case', 'pascal-case', 'upper-case']],
    'type-enum': [
      2,
      'always',
      ['feat', 'fix', 'perf', 'refactor', 'test', 'docs', 'build', 'ci', 'chore', 'revert', 'security'],
    ],
  },
};
