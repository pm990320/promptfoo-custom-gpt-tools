import { CodeInterpreterProvider } from '../dist/index.js';

export default new CodeInterpreterProvider({
  model: 'gpt-5.2',
  instructions: 'file://./system_prompt.md',
  knowledge_files: ['./knowledge/grading_rules.py'],
  input_files: ['{{input_file}}'],
  container: {
    memory_limit: '4g',
    cleanup: 'on-success',
    reuse_by_knowledge_hash: true,
  },
  output_dir: './eval_output',
  timeout_ms: 120000,
});
