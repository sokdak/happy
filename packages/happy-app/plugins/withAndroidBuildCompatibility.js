const { withAppBuildGradle, withGradleProperties } = require('@expo/config-plugins');

module.exports = function withAndroidBuildCompatibility(config) {
  config = withAppBuildGradle(config, (gradleConfig) => {
    if (gradleConfig.modResults.language !== 'groovy') {
      return gradleConfig;
    }

    const entryFileConfig = '    extraPackagerArgs = ["--entry-file", new File(projectRoot, "index.ts").getAbsolutePath()]';
    if (!gradleConfig.modResults.contents.includes(entryFileConfig)) {
      gradleConfig.modResults.contents = gradleConfig.modResults.contents.replace(
        '    bundleCommand = "export:embed"',
        '    bundleCommand = "export:embed"\n' + entryFileConfig,
      );
    }

    const nativeBuildConfig = `android {
    externalNativeBuild {
        cmake {
            buildStagingDirectory System.getProperty("os.name").toLowerCase().contains("windows")
                ? new File(System.getenv("SystemDrive") + "/happy-app-cxx")
                : new File(System.getProperty("java.io.tmpdir"), "happy-app-cxx")
        }
    }`;
    if (!gradleConfig.modResults.contents.includes('"happy-app-cxx"')) {
      gradleConfig.modResults.contents = gradleConfig.modResults.contents.replace('android {', nativeBuildConfig);
    }

    return gradleConfig;
  });

  return withGradleProperties(config, (gradleConfig) => {
    const jvmArgs = gradleConfig.modResults.find(
      (property) => property.type === 'property' && property.key === 'org.gradle.jvmargs',
    );
    const value = '-Xmx4096m -XX:MaxMetaspaceSize=1024m';
    if (jvmArgs) {
      jvmArgs.value = value;
    } else {
      gradleConfig.modResults.push({
        type: 'property',
        key: 'org.gradle.jvmargs',
        value,
      });
    }
    return gradleConfig;
  });
};
