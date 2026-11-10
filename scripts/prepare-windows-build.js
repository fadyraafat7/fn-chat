const fs = require('fs');
const patches = [
 ['node_modules/expo-constants/scripts/get-app-config-android.gradle', 'commandLine("cmd", "/c", *nodeExecutableAndArgs,', 'commandLine(*nodeExecutableAndArgs,'],
 ['node_modules/expo-modules-autolinking/android/expo-gradle-plugin/expo-autolinking-plugin-shared/src/main/kotlin/expo/modules/plugin/Os.kt', 'listOf("cmd", "/c") + args', 'args'],
 ['node_modules/@react-native/gradle-plugin/shared/src/main/kotlin/com/facebook/react/utils/TaskUtils.kt', 'listOf("cmd", "/c") + args', 'args'],
];
for (const [file, before, after] of patches) {
 const value = fs.readFileSync(file, 'utf8');
 if (value.includes(before)) fs.writeFileSync(file, value.replace(before, after));
}
console.log('Windows build commands use direct execution for paths containing shell characters.');
