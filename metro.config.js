const { getDefaultConfig } = require('expo/metro-config');
const config = getDefaultConfig(__dirname);
const inherited = config.resolver.blockList || [];
config.resolver.blockList = [
  ...[].concat(inherited),
  /[/\\]\.tools[/\\]/,
  /[/\\]artifacts[/\\]/,
  /[/\\]android[/\\](?:app[/\\])?(?:build|\.gradle|\.cxx)[/\\]/,
];
module.exports = config;
