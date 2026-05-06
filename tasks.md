# Tasks: Fix Progress Bar Bug

## Phase 1: Debug Logging (Identify Root Cause)

- [ ] 1.1 Add console.log to client.ts stdout data handler — log each chunk received and any JSON parse attempts
- [ ] 1.2 Add debug logging to server.ts progressCallback — log when callback is invoked with current/total values
- [ ] 1.3 Add debug logging to logger.ts broadcast method — log number of clients and each event sent
- [ ] 1.4 Run conversion and observe debug output to identify where progress events are lost

## Phase 2: Root Cause Analysis

- [ ] 2.1 Analyze client.ts chunk processing — check if progress JSON lines are being split across stdout chunks
- [ ] 2.2 Analyze timing issue — verify progress callback fires before/during/after convertWithYtMusic
- [ ] 2.3 Analyze SSE delivery — verify /events endpoint delivers progress events to browser

## Phase 3: Implement Fix

- [ ] 3.1 Fix stdout buffering issue in client.ts if that's the root cause (use line-by-line parsing)
- [ ] 3.2 Fix final result overwrite issue in client.ts if progress events are being lost
- [ ] 3.3 Fix SSE delivery if that's the root cause (ensure /events endpoint sends progress events)
- [ ] 3.4 Remove debug logging after fix is verified

## Phase 4: Verification

- [ ] 4.1 Run conversion with sample playlist
- [ ] 4.2 Verify progress bar updates from 0% to 100% incrementally
- [ ] 4.3 Test with multiple tracks to ensure consistent progress updates