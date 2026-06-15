// @ts-nocheck
import {
	Bell,
	BookOpen,
	Github,
	Info,
	MessageCircle,
	Settings,
	UserPlus,
	X,
} from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import { closeFromScrim, useEscapeToClose } from "./modalUtils";
import { cn } from "./classNames";

export function AboutModal({ onClose }: { onClose: () => void }) {
	useEscapeToClose(onClose);

	return (
		<div
			className={cn("modal-scrim")}
			role="presentation"
			onMouseDown={closeFromScrim(onClose)}
		>
			<section
				className={cn("app-modal compact-modal")}
				role="dialog"
				aria-modal="true"
			>
				<header className={cn("modal-titlebar")}>
					<div>
						<span>关于</span>
						<h2>Webark IM Template</h2>
					</div>
					<button className={cn("icon-button")} onClick={onClose} title="关闭">
						<X size={22} />
					</button>
				</header>
				<section className={cn("modal-card")}>
					<div className={cn("brand-mark")}>
						<img className={cn("app-logo-img")} src="/favicon.svg" alt="" />
					</div>
					<h3>Webark IM Template</h3>
					<p>一套可复用的 React IM 前端模板。</p>
					<a
						className={cn("secondary-button about-link")}
						href="https://github.com/dogxii/webark-im-template"
						target="_blank"
						rel="noreferrer"
					>
						<Github size={17} />
						dogxii/webark-im-template
					</a>
				</section>
			</section>
		</div>
	);
}

export function HelpModal({ onClose }: { onClose: () => void }) {
	const [active, setActive] = useState<HelpTab>("intro");
	useEscapeToClose(onClose);

	const activeTab = helpTabs.find((tab) => tab.id === active) ?? helpTabs[0];

	return (
		<div
			className={cn("modal-scrim")}
			role="presentation"
			onMouseDown={closeFromScrim(onClose)}
		>
			<section
				className={cn("app-modal settings-modal help-modal")}
				role="dialog"
				aria-modal="true"
			>
				<aside className={cn("modal-nav")}>
					<strong>帮助</strong>
					{helpTabs.map((tab) => (
						<button
							className={cn(active === tab.id ? "active" : "")}
							key={tab.id}
							onClick={() => setActive(tab.id)}
							type="button"
						>
							{tab.icon}
							{tab.label}
						</button>
					))}
				</aside>

				<main className={cn("modal-main")}>
					<header className={cn("modal-titlebar")}>
						<div>
							<h2>{activeTab.title}</h2>
						</div>
						<button
							className={cn("icon-button")}
							onClick={onClose}
							title="关闭"
						>
							<X size={22} />
						</button>
					</header>
					{active === "intro" ? (
						<IntroHelp />
					) : (
						<HelpArticle page={helpPages[active]} />
					)}
				</main>
			</section>
		</div>
	);
}

type HelpTab =
	| "intro"
	| "chat"
	| "notifications"
	| "contacts"
	| "interface"
	| "docs";

const helpTabs: Array<{
	id: HelpTab;
	label: string;
	title: string;
	icon: ReactNode;
}> = [
	{
		id: "intro",
		label: "概览",
		title: "概览",
		icon: <Info size={22} />,
	},
	{
		id: "chat",
		label: "聊天",
		title: "聊天使用",
		icon: <MessageCircle size={22} />,
	},
	{
		id: "notifications",
		label: "消息通知",
		title: "通知接入",
		icon: <Bell size={22} />,
	},
	{
		id: "contacts",
		label: "联系人",
		title: "联系人与群聊",
		icon: <UserPlus size={22} />,
	},
	{
		id: "interface",
		label: "界面设置",
		title: "界面与偏好",
		icon: <Settings size={22} />,
	},
	{
		id: "docs",
		label: "文档索引",
		title: "文档索引",
		icon: <BookOpen size={22} />,
	},
];

type HelpArticlePage = {
	lead: string;
	sections: Array<{
		title: string;
		items: Array<{
			title: string;
			body: string;
		}>;
	}>;
};

const helpPages: Record<Exclude<HelpTab, "intro">, HelpArticlePage> = {
	chat: {
		lead: "聊天页负责会话、消息、输入和常用操作，桌面端偏效率，移动端偏轻快。",
		sections: [
			{
				title: "会话",
				items: [
					{
						title: "实时更新",
						body: "消息列表、未读状态和会话预览可以接入 WebSocket、SSE 或轮询。",
					},
					{
						title: "Markdown",
						body: "消息支持 Markdown、图片与代码块；代码块右上角提供复制入口。",
					},
					{
						title: "移动端输入",
						body: "输入内容会随行数自动增高，较长文本可以展开到全屏编辑后再发送。",
					},
				],
			},
			{
				title: "消息操作",
				items: [
					{
						title: "长按菜单",
						body: "移动端长按消息会出现操作菜单，文字消息可以复制，图片消息可以下载。",
					},
					{
						title: "流式状态",
						body: "模板内置 streaming、complete、failed 状态，适合机器人或 AI 回复。",
					},
				],
			},
		],
	},
	notifications: {
		lead: "通知设置提供清晰入口，具体推送服务由你的应用接入。",
		sections: [
			{
				title: "通知模式",
				items: [
					{
						title: "显示内容",
						body: "适合可信设备，可以展示发送者和消息摘要。",
					},
					{
						title: "隐藏内容",
						body: "只提示有新消息，适合公共场景或锁屏隐私要求更高的设备。",
					},
					{
						title: "关闭通知",
						body: "仍然可以在应用内接收消息，但不会触发外部推送。",
					},
				],
			},
			{
				title: "接入建议",
				items: [
					{
						title: "服务端推送",
						body: "宿主应用可以接 Bark、邮件、企业微信、APNs 或自建通知服务。",
					},
					{
						title: "本地通知",
						body: "桌面端或 PWA 可以把通知设置映射到浏览器 Notification 权限。",
					},
				],
			},
		],
	},
	contacts: {
		lead: "联系人页负责好友申请、群通知和资料查看，移动端会进入单独的详情页。",
		sections: [
			{
				title: "好友",
				items: [
					{
						title: "添加联系人",
						body: "可以通过 ID 搜索用户并发送申请，也可以通过邀请码或二维码分享入口邀请。",
					},
					{
						title: "新朋友",
						body: "好友申请集中在新朋友页面处理，通过后会出现在联系人列表。",
					},
				],
			},
			{
				title: "群聊",
				items: [
					{
						title: "群通知",
						body: "入群申请和群相关提示集中在群通知页面，便于移动端快速处理。",
					},
					{
						title: "群资料",
						body: "桌面端群资料可以从右侧折叠，移动端则进入独立详情页。",
					},
				],
			},
		],
	},
	interface: {
		lead: "界面设置负责外观、通知偏好和账号资料，桌面端与移动端各自适配。",
		sections: [
			{
				title: "外观",
				items: [
					{
						title: "主题",
						body: "支持浅色、夜间和跟随系统，夜间模式会同步覆盖聊天、弹窗和导航。",
					},
					{
						title: "布局",
						body: "桌面端会记住侧栏宽度，移动端优先保留熟悉的 IM 比例。",
					},
				],
			},
			{
				title: "账号",
				items: [
					{
						title: "资料",
						body: "头像、昵称和资料展示复用同一套用户信息，减少维护成本。",
					},
					{
						title: "扩展",
						body: "设置页支持额外面板注册，适合作为宿主应用插件入口。",
					},
				],
			},
		],
	},
	docs: {
		lead: "这里整理常用入口和接入方式，方便快速熟悉模板结构。",
		sections: [
			{
				title: "使用文档",
				items: [
					{
						title: "快速开始",
						body: "先传入用户、联系人、会话和消息，再把发送、资料和设置回调接到你的应用。",
					},
					{
						title: "移动端说明",
						body: "移动端优先保留聊天、联系人和详情入口，复杂功能逐步补充。",
					},
					{
						title: "桌面端说明",
						body: "桌面端采用三栏聊天布局，常用设置集中在弹窗内完成。",
					},
				],
			},
			{
				title: "界面说明",
				items: [
					{
						title: "样式系统",
						body: "界面以轻量 CSS 和模板组件为主，方便在应用层继续定制。",
					},
					{
						title: "扩展方式",
						body: "上传、机器人、插件和业务 API 可以通过注册表分层接入。",
					},
				],
			},
		],
	},
};

function IntroHelp() {
	return (
		<>
			<section className={cn("modal-card help-intro-card")}>
				<div className={cn("help-intro-brand")}>
					<div className={cn("brand-mark")}>
						<img className={cn("app-logo-img")} src="/favicon.svg" alt="" />
					</div>
					<div>
						<h3>Webark IM Template</h3>
						<p>
							面向 IM 产品的前端模板，包含聊天、联系人、群资料、设置和帮助页面。
						</p>
					</div>
				</div>
				<div className={cn("help-intro-actions")}>
					<a
						className={cn("secondary-button about-link")}
						href="https://github.com/dogxii/webark-im-template"
						target="_blank"
						rel="noreferrer"
					>
						<Github size={17} />
						GitHub 项目
					</a>
				</div>
			</section>

			<section className={cn("modal-card help-card")}>
				<h3>使用重点</h3>
				<HelpList
					items={[
						{
							title: "可套用",
							body: "模板提供前端结构和状态交互，登录、服务端、上传和机器人由你的应用接入。",
						},
						{
							title: "双端体验",
							body: "桌面端偏效率，移动端偏熟悉 IM 比例，不追求一次塞满所有功能。",
						},
						{
							title: "保持简洁",
							body: "聊天、联系人和设置保持轻量清晰，扩展能力通过明确入口接入。",
						},
					]}
				/>
			</section>
		</>
	);
}

function HelpArticle({ page }: { page: HelpArticlePage }) {
	return (
		<>
			<section className={cn("modal-card help-card")}>
				<h3>概览</h3>
				<p>{page.lead}</p>
			</section>
			{page.sections.map((section) => (
				<section className={cn("modal-card help-card")} key={section.title}>
					<h3>{section.title}</h3>
					<HelpList items={section.items} />
				</section>
			))}
		</>
	);
}

function HelpList({
	items,
}: {
	items: Array<{
		title: string;
		body: string;
	}>;
}) {
	return (
		<ul className={cn("help-list")}>
			{items.map((item) => (
				<li key={item.title}>
					<strong>{item.title}</strong>
					<span>{item.body}</span>
				</li>
			))}
		</ul>
	);
}
