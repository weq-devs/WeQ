// @ts-nocheck
type AvatarPalette = {
	bg: string;
	ring: string;
	body: string;
	face: string;
	eye: string;
	accent: string;
	shadow: string;
};

const PALETTES: AvatarPalette[] = [
	{
		bg: "#eef6ff",
		ring: "#d8ebff",
		body: "#dce8f3",
		face: "#f8fbff",
		eye: "#8aa0b2",
		accent: "#1298f0",
		shadow: "#d4e2ee",
	},
	{
		bg: "#effaf4",
		ring: "#d8f0e2",
		body: "#dcebe3",
		face: "#fbfffd",
		eye: "#83a08d",
		accent: "#21c978",
		shadow: "#d3e4da",
	},
	{
		bg: "#fff7e8",
		ring: "#f4e3bf",
		body: "#ece0ca",
		face: "#fffdf8",
		eye: "#a19379",
		accent: "#ffb22d",
		shadow: "#e8d9bb",
	},
	{
		bg: "#fff0f3",
		ring: "#f2d7df",
		body: "#eadce2",
		face: "#fff9fb",
		eye: "#a18691",
		accent: "#ff6b8d",
		shadow: "#e5d1da",
	},
	{
		bg: "#f3f1ff",
		ring: "#dedafd",
		body: "#e0ddf0",
		face: "#fbfaff",
		eye: "#8c88aa",
		accent: "#7c6cf2",
		shadow: "#d8d3ee",
	},
	{
		bg: "#f1fbfb",
		ring: "#d8eeee",
		body: "#dceaea",
		face: "#fbffff",
		eye: "#7f9d9d",
		accent: "#1ab3bd",
		shadow: "#d3e5e5",
	},
];

export function pickDefaultAvatarIndex(seed: string) {
	let hash = 0;

	for (let index = 0; index < seed.length; index += 1) {
		hash = (hash * 31 + seed.charCodeAt(index)) >>> 0;
	}

	return hash % PALETTES.length;
}

export function DefaultAvatar({ seed }: { seed: string }) {
	const index = pickDefaultAvatarIndex(seed);
	const palette = PALETTES[index];
	const blink = index % 3 === 1;
	const softSmile = index % 3 === 2;

	return (
		<svg
			aria-hidden="true"
			focusable="false"
			viewBox="0 0 96 96"
			xmlns="http://www.w3.org/2000/svg"
		>
			<circle cx="48" cy="48" r="48" fill={palette.bg} />
			<circle
				cx="48"
				cy="48"
				r="43"
				fill="none"
				stroke={palette.ring}
				strokeWidth="2"
			/>
			<ellipse
				cx="48"
				cy="77.5"
				rx="23"
				ry="4.5"
				fill={palette.shadow}
				opacity="0.72"
			/>
			<path
				d="M48 18.4C64.2 18.4 77.1 30 77.1 45.5C77.1 61 64.3 72.5 48.4 72.5C44.1 72.5 40.1 71.8 36.4 70.4L22.8 75.5L27.4 62.8C22.2 58.2 19.2 52.2 19.2 45.5C19.2 30 31.9 18.4 48 18.4Z"
				fill={palette.body}
			/>
			<path
				d="M27.5 59.7C23.7 55.6 21.7 50.8 21.7 45.8C21.7 31.9 33 21.3 48 21.3C63 21.3 74.3 31.9 74.3 45.8C74.3 59.7 63 70.1 48 70.1C43.9 70.1 40 69.4 36.5 68.1L27.6 71.3L30.6 62.7C29.5 61.8 28.4 60.8 27.5 59.7Z"
				fill={palette.face}
				opacity="0.72"
			/>
			<ellipse
				cx="39.6"
				cy="43.2"
				rx="4.2"
				ry={blink ? "2.1" : "7.1"}
				fill="#ffffff"
			/>
			<ellipse
				cx="56.4"
				cy="43.2"
				rx="4.2"
				ry={blink ? "2.1" : "7.1"}
				fill="#ffffff"
			/>
			{blink ? (
				<>
					<path
						d="M35.9 43.1H43.2"
						stroke={palette.eye}
						strokeWidth="2.4"
						strokeLinecap="round"
					/>
					<path
						d="M52.8 43.1H60.1"
						stroke={palette.eye}
						strokeWidth="2.4"
						strokeLinecap="round"
					/>
				</>
			) : (
				<>
					<circle cx="41" cy="40.4" r="1.85" fill={palette.eye} />
					<circle cx="57.8" cy="40.4" r="1.85" fill={palette.eye} />
				</>
			)}
			{softSmile ? (
				<path
					d="M42.3 54.4C45.3 57 50.8 57.1 54.1 54.4"
					stroke={palette.eye}
					strokeWidth="2.2"
					strokeLinecap="round"
					fill="none"
					opacity="0.55"
				/>
			) : null}
			<path
				d="M62.5 24.8C67.6 22.4 73.5 24.5 75.8 29.6"
				stroke={palette.ring}
				strokeWidth="4"
				strokeLinecap="round"
			/>
			<path
				d="M66.7 17.6C74 14.8 82.4 18.4 85.1 25.7"
				stroke={palette.ring}
				strokeWidth="3.4"
				strokeLinecap="round"
				opacity="0.8"
			/>
			<circle cx="76.5" cy="26" r="5.6" fill={palette.accent} />
			<circle cx="78" cy="24.4" r="1.7" fill="#ffffff" opacity="0.75" />
		</svg>
	);
}
