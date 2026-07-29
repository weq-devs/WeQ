
import { Minus, Square, X, } from "lucide-react";
import { Avatar } from "./primitives";
import type { User } from "./types";
import { displayUserName } from "./user";
import logoUrl from "@resources/brand/logo.png";

export function TitleBar({
	user,
	homeActive = false,
	onGoHome,
}: {
	user: User;
	homeActive?: boolean;
	onGoHome?: () => void;
}) {
	const handleMinimize = () => {
		window.electron?.ipcRenderer.send("window-minimize");
	};

	const handleMaximize = () => {
		window.electron?.ipcRenderer.send("window-maximize");
	};

	const handleClose = () => {
		window.electron?.ipcRenderer.send("window-close");
	};

	return (
		<div className="app-title-bar">
			<button
				type="button"
				className={`app-title-bar-logo-wrap${homeActive ? " is-active" : ""}`}
				title="主页"
				onClick={onGoHome}
			>
				<img src={logoUrl} className="app-title-bar-logo" alt="主页" />
			</button>
			<div className="app-title-bar-user">
				<Avatar
					name={displayUserName(user)}
					avatarUrl={user.avatarUrl}
					seed={user.identityValue}
				/>
				<span className="app-title-bar-nick">{displayUserName(user)}</span>
				{user.signature && (
					<span className="app-title-bar-signature">{user.signature}</span>
				)}
				</div>
			<div className="app-title-bar-drag" />
			<div className="app-title-bar-actions">
				<button onClick={handleMinimize} title="最小化">
					<Minus size={14} />
				</button>
				<button onClick={handleMaximize} title="全屏/还原">
					<Square size={12} />
				</button>
				<button onClick={handleClose} className="close" title="关闭">
					<X size={16} />
				</button>
			</div>
		</div>
	);
}
