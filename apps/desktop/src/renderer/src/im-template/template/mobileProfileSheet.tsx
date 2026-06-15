// @ts-nocheck
import {
	ChevronLeft,
	ChevronRight,
	Moon,
	QrCode,
	Settings,
	X,
} from "lucide-react";
import QRCode from "qrcode";
import type { ReactNode, TouchEvent } from "react";
import { useEffect, useRef, useState } from "react";
import { cn } from "./classNames";
import { Avatar } from "./primitives";
import type { SettingsTab, User } from "./types";
import type { ThemePreference } from "./theme";
import { displayUserName } from "./user";

function fixedMobileProfileQrUrl(user: User) {
	return `${window.location.origin}/add/${encodeURIComponent(user.identityValue)}`;
}

function mobileProfileQrAddress(qrUrl: string) {
	try {
		return new URL(qrUrl).host;
	} catch {
		return qrUrl;
	}
}

export function MobileProfileSheet({
	user,
	themePreference,
	onThemePreferenceChange,
	onClose,
	onOpenSettings,
	onOpenProfileEditor,
}: {
	user: User;
	themePreference: ThemePreference;
	onThemePreferenceChange: (preference: ThemePreference) => void;
	onClose: () => void;
	onOpenSettings: (tab?: SettingsTab) => void;
	onOpenProfileEditor: () => void;
}) {
	const touchStartXRef = useRef<number | null>(null);
	const [qrOpen, setQrOpen] = useState(false);
	const [qrDataUrl, setQrDataUrl] = useState("");
	const backgroundUrl = user.avatarUrl ?? "/favicon.svg";
	const qrUrl = fixedMobileProfileQrUrl(user);
	const qrAddress = mobileProfileQrAddress(qrUrl);

	useEffect(() => {
		if (!qrOpen) {
			return;
		}

		let cancelled = false;
		setQrDataUrl("");
		QRCode.toDataURL(qrUrl, {
			errorCorrectionLevel: "H",
			margin: 1,
			width: 680,
			color: {
				dark: "#56a8f7",
				light: "#ffffff",
			},
		})
			.then((dataUrl) => {
				if (!cancelled) {
					setQrDataUrl(dataUrl);
				}
			})
			.catch(() => {
				if (!cancelled) {
					setQrDataUrl("");
				}
			});

		return () => {
			cancelled = true;
		};
	}, [qrOpen, qrUrl]);

	function handleTouchStart(event: TouchEvent<HTMLElement>) {
		touchStartXRef.current = event.touches[0]?.clientX ?? null;
	}

	function handleTouchEnd(event: TouchEvent<HTMLElement>) {
		const startX = touchStartXRef.current;
		const endX = event.changedTouches[0]?.clientX;
		touchStartXRef.current = null;
		if (startX === null || endX === undefined) {
			return;
		}
		if (endX - startX < -70) {
			onClose();
		}
	}

	function toggleTheme() {
		onThemePreferenceChange(themePreference === "dark" ? "light" : "dark");
	}

	if (qrOpen) {
		return (
			<MobileProfileQrPage
				user={user}
				qrDataUrl={qrDataUrl}
				qrAddress={qrAddress}
				onBack={() => setQrOpen(false)}
				onTouchStart={handleTouchStart}
				onTouchEnd={handleTouchEnd}
			/>
		);
	}

	return (
		<section
			className={cn("mobile-profile-sheet")}
			onTouchStart={handleTouchStart}
			onTouchEnd={handleTouchEnd}
		>
			<main className={cn("mobile-profile-main")}>
				<section
					className={cn("mobile-profile-hero")}
					style={{
						backgroundImage: `linear-gradient(180deg, rgba(16, 26, 42, 0.42), rgba(16, 26, 42, 0.55)), url(${backgroundUrl})`,
						backgroundPosition: "center",
						backgroundSize: "cover",
					}}
				>
					<div className={cn("mobile-profile-hero-actions")}>
						<button
							className={cn("mobile-profile-action")}
							type="button"
							title="关闭"
							onClick={onClose}
						>
							<X size={31} />
						</button>
					</div>
				</section>

				<section className={cn("mobile-profile-card")}>
					<div className={cn("mobile-profile-summary")}>
						<button
							className={cn("mobile-profile-avatar-button")}
							type="button"
							title="编辑资料"
							onClick={onOpenProfileEditor}
						>
							<Avatar
								name={displayUserName(user)}
								avatarUrl={user.avatarUrl}
								seed={user.identityValue}
							/>
						</button>
						<div className={cn("mobile-profile-copy")}>
							<strong>{displayUserName(user)}</strong>
							<p>
								{user.identityLabel} {user.identityValue}
							</p>
						</div>
						<button
							className={cn("mobile-profile-qr-button")}
							type="button"
							title="我的二维码"
							onClick={() => setQrOpen(true)}
						>
							<QrCode size={30} color="#70737a" />
						</button>
					</div>
				</section>

				<section className={cn("mobile-profile-meta-card")}>
					<button
						className={cn("mobile-profile-meta-row")}
						type="button"
						onClick={onOpenProfileEditor}
					>
						<span>编辑资料</span>
						<strong>头像和昵称</strong>
						<ChevronRight size={24} />
					</button>
					<button
						className={cn("mobile-profile-meta-row")}
						type="button"
						onClick={() => setQrOpen(true)}
					>
						<span>我的二维码</span>
						<strong>
							{user.identityLabel} {user.identityValue}
						</strong>
						<ChevronRight size={24} />
					</button>
					<div className={cn("mobile-profile-meta-row", "static")}>
						<span>在线状态</span>
						<strong>在线</strong>
					</div>
				</section>
			</main>

			<footer className={cn("mobile-profile-footer")}>
				<ProfileFooterButton
					icon={<Settings size={33} />}
					label="设置"
					onClick={() => onOpenSettings("general")}
				/>
				<ProfileFooterButton
					icon={<Moon size={33} />}
					label="夜间"
					onClick={toggleTheme}
				/>
			</footer>
		</section>
	);
}

function MobileProfileQrPage({
	user,
	qrDataUrl,
	qrAddress,
	onBack,
	onTouchStart,
	onTouchEnd,
}: {
	user: User;
	qrDataUrl: string;
	qrAddress: string;
	onBack: () => void;
	onTouchStart: (event: TouchEvent<HTMLElement>) => void;
	onTouchEnd: (event: TouchEvent<HTMLElement>) => void;
}) {
	return (
		<section
			className={cn("mobile-profile-qr-page")}
			onTouchStart={onTouchStart}
			onTouchEnd={onTouchEnd}
		>
			<header className={cn("mobile-profile-qr-header")}>
				<button
					className={cn("mobile-profile-qr-back")}
					type="button"
					title="返回"
					onClick={onBack}
				>
					<ChevronLeft size={34} />
				</button>
				<strong>我的二维码</strong>
				<span />
			</header>

			<main className={cn("mobile-profile-qr-main")}>
				<section className={cn("mobile-profile-qr-card")}>
					<div className={cn("mobile-profile-qr-user")}>
						<Avatar
							name={displayUserName(user)}
							avatarUrl={user.avatarUrl}
							seed={user.identityValue}
						/>
						<div>
							<strong>{displayUserName(user)}</strong>
							<span>
								{user.identityLabel}: {user.identityValue}
							</span>
						</div>
					</div>
					<div className={cn("mobile-profile-qr-code")}>
						{qrDataUrl ? (
							<img src={qrDataUrl} alt="我的二维码" />
						) : (
							<span>生成中</span>
						)}
						{qrDataUrl ? (
							<span className={cn("mobile-profile-qr-logo")}>
								<img src="/favicon.svg" alt="" />
							</span>
						) : null}
					</div>
					<p>扫一扫加我为好友</p>
					<span className={cn("mobile-profile-qr-address")}>{qrAddress}</span>
				</section>
			</main>
		</section>
	);
}

function ProfileFooterButton({
	icon,
	label,
	onClick,
}: {
	icon: ReactNode;
	label: string;
	onClick?: () => void;
}) {
	return (
		<button
			className={cn("mobile-profile-footer-button")}
			type="button"
			onClick={onClick}
		>
			{icon}
			<span>{label}</span>
		</button>
	);
}
