// @ts-nocheck
import type { User } from "./types";

export function displayUserName(user: Pick<User, "displayName" | "username">) {
	return user.displayName || user.username;
}
