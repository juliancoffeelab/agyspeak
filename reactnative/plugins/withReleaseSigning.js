const fs = require("node:fs");
const path = require("node:path");
const { withAppBuildGradle, withDangerousMod } = require("expo/config-plugins");

// The development build overrides the adaptive icon's background with a dark
// one, so the two installed apps are distinguishable on the launcher.
const DEV_BACKGROUND = "assets/android-icon-background-dev.png";
const DEV_ADAPTIVE_ICON_XML = `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@drawable/ic_launcher_background_dev"/>
    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>
    <monochrome android:drawable="@mipmap/ic_launcher_monochrome"/>
</adaptive-icon>
`;

function withDevelopmentIcon(config) {
  return withDangerousMod(config, [
    "android",
    (config) => {
      const { projectRoot, platformProjectRoot } = config.modRequest;
      const res = path.join(platformProjectRoot, "app/src/debug/res");
      fs.mkdirSync(path.join(res, "drawable-nodpi"), { recursive: true });
      fs.copyFileSync(
        path.join(projectRoot, DEV_BACKGROUND),
        path.join(res, "drawable-nodpi/ic_launcher_background_dev.png"),
      );
      fs.mkdirSync(path.join(res, "mipmap-anydpi-v26"), { recursive: true });
      for (const name of ["ic_launcher", "ic_launcher_round"])
        fs.writeFileSync(
          path.join(res, `mipmap-anydpi-v26/${name}.xml`),
          DEV_ADAPTIVE_ICON_XML,
        );
      return config;
    },
  ]);
}

module.exports = function withReleaseSigning(config) {
  return withAppBuildGradle(withDevelopmentIcon(config), (config) => {
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
