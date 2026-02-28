# Example: Student Gradebook Processor

This example evaluates a Custom GPT that processes student gradebook CSVs -
calculating weighted averages, assigning letter grades, and generating a
formatted Excel workbook with class statistics.

## Files

```
example/
├── promptfooconfig.yaml       # Eval config with test cases + assertions
├── provider.js                # Provider setup (CodeInterpreterProvider)
├── system_prompt.md           # GPT instructions
├── knowledge/
│   └── grading_rules.py       # Grading logic (uploaded as knowledge file)
└── test_data/
    ├── gradebook_simple.csv   # 10 students, 3 assignments
    └── gradebook_weighted.csv # 15 students, 5 assignments with weights
```

## Setup

```bash
# Install dependencies
npm install promptfoo promptfoo-custom-gpt-tools

# Set your API key (or use Codex CLI auth)
export OPENAI_API_KEY="sk-..."

# Run the eval
npx promptfoo eval -c example/promptfooconfig.yaml
```

## Auth options

### API key (default)
```bash
export OPENAI_API_KEY="sk-..."
```

### Codex CLI (use ChatGPT subscription)
```bash
codex login
# Then set auth: 'codex' in provider.js
```

## What it tests

1. **Output file exists** and is a valid .xlsx
2. **Required sheets** are present (Grades, Statistics)
3. **Letter grade column** was added
4. **No error values** (#DIV/0!, NaN, etc.)
5. **All students have grades** (no empty cells in the grade column)
6. **Original data preserved** (input scores aren't modified)
