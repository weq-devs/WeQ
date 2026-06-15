// @ts-nocheck
import { ChevronRight } from "lucide-react";
import {
	conversationDetailActionLabel,
	isConversationDetailActionChecked,
	isConversationDetailActionDisabled,
	type ConversationDetailAction,
	type ConversationDetailActionContext,
	type ConversationDetailActionGroup,
} from "./conversationDetailActions";
import { cn } from "./classNames";
import { ToggleRow } from "./primitives";

export function DesktopDetailActionGroups({
	groups,
	context,
}: {
	groups: ConversationDetailActionGroup[];
	context: ConversationDetailActionContext;
}) {
	return (
		<>
			{groups.map((group) => {
				if (group.variant === "standalone") {
					return group.actions.map((action) => (
						<DesktopDetailActionRow
							action={action}
							context={context}
							key={`${group.id}-${action.id}`}
						/>
					));
				}

				return (
					<section className={cn("details-card")} key={group.id}>
						{group.actions.map((action) => (
							<DesktopDetailActionRow
								action={action}
								context={context}
								key={action.id}
							/>
						))}
					</section>
				);
			})}
		</>
	);
}

function DesktopDetailActionRow({
	action,
	context,
}: {
	action: ConversationDetailAction;
	context: ConversationDetailActionContext;
}) {
	const label = conversationDetailActionLabel(action, context);

	if (action.kind === "switch") {
		return (
			<ToggleRow
				label={label}
				checked={isConversationDetailActionChecked(action, context)}
				onClick={() => void action.onClick(context)}
			/>
		);
	}

	return (
		<button
			className={cn("details-row")}
			type="button"
			disabled={isConversationDetailActionDisabled(action, context)}
			onClick={() => void action.onClick(context)}
		>
			<span>{label}</span>
			<ChevronRight size={20} />
		</button>
	);
}
