// Webpack config for the velocity-webex-calling widget.
//
// Single entry, single UMD output: dist/velocity-webex-calling.js, defining
// the <velocity-webex-calling> custom element (mirrors the "one script tag,
// one custom element" packaging pattern in
// reference/webex-contact-center-widget-starter/lit-element/webpack.config.ts).
//
// The `resolve.fallback` + ProvidePlugin block below is NOT needed by Phase 1's
// placeholder code. It exists now so Phase 3 can `import` @webex/calling
// without any webpack rework: per DISCOVERY.md §5, that SDK assumes several
// Node builtins are present (http/https/crypto/stream/os/url/assert/
// querystring, plus a global `process`), which Webpack 5 no longer polyfills
// automatically.
const path = require('path');
const webpack = require('webpack');

module.exports = (env, argv) => {
  const isProd = (argv && argv.mode) === 'production';

  return {
    mode: isProd ? 'production' : 'development',
    // Entry is bundle.ts (element + Phase 3 calling API), NOT index.ts. index.ts
    // stays SDK-free so unit tests can import it without loading @webex/calling;
    // bundle.ts is the only module that pulls the SDK in. See src/bundle.ts.
    entry: './src/bundle.ts',
    devtool: isProd ? false : 'source-map',
    output: {
      path: path.resolve(__dirname, 'dist'),
      filename: 'velocity-webex-calling.js',
      library: {
        name: 'VelocityWebexCalling',
        type: 'umd',
      },
      // Required for UMD output to work in both browser <script> tags and
      // Node-based test/SSR contexts.
      globalObject: 'this',
      clean: true,
    },
    resolve: {
      extensions: ['.ts', '.js'],
      fallback: {
        http: require.resolve('stream-http'),
        https: require.resolve('https-browserify'),
        crypto: require.resolve('crypto-browserify'),
        stream: require.resolve('stream-browserify'),
        os: require.resolve('os-browserify/browser'),
        url: require.resolve('url/'),
        assert: require.resolve('assert/'),
        querystring: require.resolve('querystring-es3'),
        buffer: require.resolve('buffer/'),
        // Added at Phase 3 when @webex/calling was installed: its transitive deps
        // (asn1.js needs `vm`; file-type/strtok3 reference `fs`) pull two more Node
        // builtins. `fs` is stubbed out (false) — the file-type code path is never
        // reached in the browser; `vm` gets a real browser shim.
        vm: require.resolve('vm-browserify'),
        fs: false,
      },
    },
    module: {
      rules: [
        {
          test: /\.ts$/,
          use: 'ts-loader',
          exclude: /node_modules/,
        },
      ],
    },
    plugins: [
      new webpack.ProvidePlugin({
        process: 'process/browser',
        Buffer: ['buffer', 'Buffer'],
      }),
    ],
  };
};
