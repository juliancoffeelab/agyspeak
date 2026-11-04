const { withAppBuildGradle } = require("expo/config-plugins");

module.exports = function withReleaseSigning(config) {
  return withAppBuildGradle(config, (config) => {
    const marker = "// AGSpeak release signing";
    if (!config.modResults.contents.includes(marker)) {
      config.modResults.contents += `
${marker}
def releaseSigningFile = new File(rootProject.projectDir, '../.signing/release.properties')
if (releaseSigningFile.exists()) {
    def credentials = new Properties()
    releaseSigningFile.withInputStream { credentials.load(it) }
    android.signingConfigs.create('agyspeakRelease') {
        storeFile new File(releaseSigningFile.parentFile, credentials.getProperty('storeFile'))
        storePassword credentials.getProperty('storePassword')
        keyAlias credentials.getProperty('keyAlias')
        keyPassword credentials.getProperty('keyPassword')
    }
    android.buildTypes.release.signingConfig = android.signingConfigs.agyspeakRelease
} else if (gradle.startParameter.taskNames.any { it.toLowerCase().contains('release') }) {
    throw new GradleException('Release signing is missing. Run pnpm build:release to generate your local signing key.')
}
`;
    }
    if (
      !config.modResults.contents.includes("// AGSpeak development identity")
    ) {
      config.modResults.contents += `
// AGSpeak development identity
android.buildTypes.debug {
    applicationIdSuffix '.dev'
    resValue 'string', 'app_name', 'AGSpeak (dev)'
}
`;
    }
    return config;
  });
};
