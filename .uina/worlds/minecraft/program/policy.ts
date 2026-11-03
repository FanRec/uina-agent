/** Initial measured-policy inputs from program.md §5; no task wall-clock deadline. */
export const PROGRAM_POLICY = {
	maxResidentGuests: 32,
	maxPendingRpcsPerGuest: 16,
	guestMemoryBytes: 32 * 1024 * 1024,
	computeBurstMs: 20,
	maxSourceBytes: 64 * 1024,
	maxValueBytes: 1024 * 1024,
	consoleBytes: 16 * 1024,
	retireGraceMs: 1000,
} as const;
