/**
 * Test script for FileSearchService.
 */

import { FileSearchService } from '../src/account/file_search';
import { createWin32Platform } from '@weq/platform';

// Mock objects
const mockNative: any = { ntHelper: {} };
const platform = createWin32Platform(mockNative);

const mockSession: any = {
  context: { uin: '1707889225' }
};

const service = new FileSearchService(mockSession, platform);

async function runTest() {
  console.log('--- Test 1: MP4 with current timestamp ---');
  // Current timestamp
  const now = Date.now();
  const hash = 'e98fca748a9cf730e565784cd478b92f';
  
  const result1 = await service.findFile(now, hash, 'video');
  console.log('Video Search Result:', JSON.stringify(result1, null, 2));

  console.log('\n--- Test 2: File type mapping (mocking search results) ---');
  // Since we can't easily put a file on the real FS and search it recursively in one go,
  // let's test the mapping logic specifically by calling the private method or 
  // checking the logic if source was found.
  
  // We can try to search for an existing file in the system if we know one, 
  // or just verify the icon mapping logic.
  const icon = (service as any).getIconForExtension('mp4');
  console.log('Extension "mp4" maps to icon:', icon);
}

runTest().catch(console.error);
