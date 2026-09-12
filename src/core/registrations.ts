/** A registration owns its exact slot. Explicit replacement restores the previous live slot on disposal. */
export class Registrations<T> {
	private readonly entries = new Map<string, Array<{ value: T }>>();
	register(name: string, value: T, options: { replace?: boolean } = {}): () => void {
		const stack = this.entries.get(name) ?? [];
		if (stack.length && !options.replace) throw new Error("已注册 / duplicate registration: " + name);
		const entry = { value };
		stack.push(entry);
		this.entries.set(name, stack);
		return () => {
			const index = stack.indexOf(entry);
			if (index >= 0) stack.splice(index, 1);
			if (!stack.length && this.entries.get(name) === stack) this.entries.delete(name);
		};
	}
	get(name: string): T | undefined {
		return this.entries.get(name)?.at(-1)?.value;
	}
	has(name: string): boolean {
		return this.entries.has(name);
	}
	keys(): string[] {
		return [...this.entries.keys()];
	}
	entriesList(): Array<[string, T]> {
		return this.keys().map((name) => [name, this.get(name)!]);
	}
	values(): T[] {
		return this.keys().map((name) => this.get(name)!);
	}
	delete(name: string): void {
		this.entries.delete(name);
	}
}
