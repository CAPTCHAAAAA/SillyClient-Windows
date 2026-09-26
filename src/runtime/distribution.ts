export interface Distribution {
  isTest: boolean;
  appId: string;
  productName: string;
  dataDirectoryName: string;
}

export function resolveDistribution(metadata: { name?: unknown; sillyClientChannel?: unknown }): Distribution {
  if (metadata.sillyClientChannel === 'migration-test'
      && metadata.name === 'sillyclient-windows-migration-test') {
    return {
      isTest: true,
      appId: 'com.sillyclient.migration-test',
      productName: 'SillyClient Migration Test',
      dataDirectoryName: 'SillyClientMigrationTest',
    };
  }
  if (metadata.sillyClientChannel === undefined && metadata.name === 'sillyclient-windows') {
    return {
      isTest: false,
      appId: 'com.sillyclient',
      productName: 'SillyClient',
      dataDirectoryName: 'SillyClient',
    };
  }
  throw new Error('Unrecognized distribution metadata; refusing to select a shared data directory.');
}
