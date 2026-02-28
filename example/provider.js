const { CodeInterpreterProvider } = require('promptfoo-custom-gpt-tools');

module.exports = new CodeInterpreterProvider({
  model: 'gpt-5.2',
  instructions: 'file://./example/system_prompt.md',
  knowledge_files: ['./example/knowledge/grading_rules.py'],
  input_files: ['{{input_file}}'],
  container: {
    memory_limit: '4g',
    cleanup: 'on-success',
    reuse_by_knowledge_hash: true,
  },
  output_dir: './example/eval_output',
  timeout_ms: 120000,

  // Uncomment to use Codex CLI OAuth instead of OPENAI_API_KEY:
  // auth: 'codex',
});
