class DebugProvider {
  constructor(options) {
    console.log('CONSTRUCTOR OPTIONS:', JSON.stringify(options, null, 2));
    const { CodeInterpreterProvider } = require('promptfoo-custom-gpt-tools');
    // promptfoo passes { id, config, ... } - extract config
    this._inner = new CodeInterpreterProvider(options.config || options);
  }
  id() { return this._inner.id(); }
  callApi(prompt, context, options) { return this._inner.callApi(prompt, context, options); }
}
module.exports = DebugProvider;
