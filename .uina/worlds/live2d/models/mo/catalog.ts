import { conversationalNod, conversationalShake, conversationalCurious, conversationalGlance, conversationalEmphasis, conversationalJoy, conversationalAvert, conversationalCloseUp } from "./motions/conversational.js";
import { idlePhrases, thinkingPhrases, speechAccent } from "./motions/natural.js";
import type { ModelRig } from "../../adapter/rig.js";
import { compileCatalog, type CatalogSnapshot, type CatalogSource } from "../../authoring/catalog.js";
import { MO_MODEL_ID } from "../rig-loader.js";

import { chinUp } from "./motions/chin_up.js";
import { closeUp } from "./motions/close_up.js";
import { curious, curiousDoubleTiltVariant } from "./motions/curious.js";
import { edgePeek } from "./motions/edge_peek.js";
import { glance, glanceDoubleTakeVariant } from "./motions/glance.js";
import { headToss, headTossPoutVariant } from "./motions/head_toss.js";
import { cuteIdle } from "./motions/idle.js";
import { joyHop } from "./motions/joy_hop.js";
import { cuteNod, cuteNodCheerfulVariant } from "./motions/nod.js";
import { panic } from "./motions/panic.js";
import { petrify } from "./motions/petrify.js";
import { pout } from "./motions/pout.js";
import { cuteShake, cuteShakePlayfulVariant } from "./motions/shake.js";
import { sleepy } from "./motions/sleepy.js";
import { smugLaugh } from "./motions/smug_laugh.js";
import { spin } from "./motions/spin.js";
import { surprise } from "./motions/surprise.js";
import { swayChaoticBouncyVariant, swayClassic, swayCornerPeekVariant, swayVShapeVariant } from "./motions/sway.js";
import { cuteThinking } from "./motions/thinking.js";
import { cuteWink, cuteWinkCheerfulVariant, cuteWinkDoubleVariant } from "./motions/wink.js";

/** MO catalog containing authored actions. */
export const MO_CATALOG_SOURCE: CatalogSource = {
	background: {
		phrases: { idle: idlePhrases, thinking: thinkingPhrases },
		accent: speechAccent,
		idle: cuteIdle,
		thinking: cuteThinking,
		ambient: {
			sway: {
				description: "活泼的左右摇摆，交替侧探、回旋和弹性回正，可作为持续背景",
				aliases: ["摇摆", "魔性摇摆", "左右横跳"],
				motion: swayClassic,
				variants: [swayCornerPeekVariant, swayChaoticBouncyVariant, swayVShapeVariant],
			},
		},
	},
	postures: {
		sleep: {
			description: "睡觉姿态：脑袋沉沉低垂侧倚，身体放松前倾呼吸，双眼紧闭安睡",
			aliases: ["睡觉", "沉睡", "睡觉姿态"],
			transitionMs: 800,
			values: {
				"head.pitch": -7.5,
				"head.roll": -3.2,
				"head.yaw": -2.0,
				"torso.pitch": 6.5,
				"torso.roll": 2.5,
				"eyes.left.open": 0,
				"eyes.right.open": 0,
				"gaze.y": -0.4,
				"mouth.open": 0.08,
			},
		},
		neutral_posture: {
			description: "正常姿态：头颈与身躯挺拔直立，视线回正迎向观众",
			aliases: ["正常姿态", "默认姿态", "站姿"],
			transitionMs: 500,
			values: {
				"head.pitch": 0,
				"head.roll": 0,
				"head.yaw": 0,
				"torso.pitch": 0,
				"torso.roll": 0,
				"torso.yaw": 0,
				"gaze.x": 0,
				"gaze.y": 0,
			},
		},
	},
	expressions: {
		closed_eyes: {
			description: "眯眯眼/闭眼：双眼安详合拢，嘴角微挑温和浅笑",
			aliases: ["闭眼", "眯眯眼", "眯眼"],
			transitionMs: 200,
			values: {
				"eyes.left.open": 0,
				"eyes.right.open": 0,
				"mouth.form": 0.25,
			},
		},
		neutral_expression: {
			description: "正常表情：双眼自然清澈睁开，五官回归中性静息",
			aliases: ["正常表情", "默认表情", "自然表情"],
			transitionMs: 200,
			values: {
				"eyes.left.open": 1,
				"eyes.right.open": 1,
				"mouth.form": 0,
				"mouth.open": 0,
			},
		},
	},
	motions: {
		nod: {
			description: "点头回应，带轻微蓄力、柔和回弹和微笑，身体稍后跟随",
			aliases: ["点头", "q弹点头", "嗯嗯"],
			motion: cuteNod,
			variants: [cuteNodCheerfulVariant, conversationalNod],
		},
		shake: {
			description: "左右摇头表示否认，配合歪头、反向眼神和小幅身体支撑",
			aliases: ["摇头", "不嘛", "才不是呢"],
			motion: cuteShake,
			variants: [cuteShakePlayfulVariant, conversationalShake],
		},
		wink: {
			description: "歪头单眼眨眼，短暂停留后轻轻回弹，带微笑",
			aliases: ["眨眼", "放电", "啾咪"],
			motion: cuteWink,
			variants: [cuteWinkCheerfulVariant, cuteWinkDoubleVariant],
		},
		curious: {
			description: "好奇地歪头抬眼，身体反向轻撑，停留后柔和回正",
			aliases: ["歪头", "猫猫歪头", "歪头杀"],
			motion: curious,
			variants: [curiousDoubleTiltVariant, conversationalCurious],
		},
		chin_up: {
			description: "得意地抬起下巴，眯眼微笑，保持轻微呼吸后回正",
			aliases: ["得意昂头", "昂头", "哼哼"],
			motion: chinUp,
			variants: [conversationalEmphasis],
		},
		head_toss: {
			description: "赌气地甩头别过脸，再用余光偷瞄，最后缓缓回正",
			aliases: ["傲娇甩头", "才不理你", "傲娇偷瞄"],
			motion: headToss,
			variants: [headTossPoutVariant, conversationalAvert],
		},
		surprise: {
			description: "惊讶后仰、张嘴发愣，短暂微震后缓神回正",
			aliases: ["惊讶", "呆住", "惊呆"],
			motion: surprise,
		},
		glance: {
			description: "眼神先向旁边一瞥，头部随后轻转，短暂停留再收回",
			aliases: ["视线一瞥", "偷瞄一眼", "斜睨"],
			motion: glance,
			variants: [glanceDoubleTakeVariant, conversationalGlance],
		},
		joy_hop: {
			description: "蓄力后向上小跳，闭眼微笑，落地缓冲并轻轻回弹",
			aliases: ["雀跃弹跳", "开心跳", "弹跳"],
			motion: joyHop,
		},
		petrify: {
			description: "受打击后僵住并褪为冷灰，带细微震颤，随后恢复色彩和动作",
			aliases: ["石化", "僵死", "晴天霹雳"],
			motion: petrify,
		},
		close_up: {
			description: "凑近镜头，轻轻歪头、微笑和慢眨眼，再退回原位",
			aliases: ["贴脸", "凑近", "怼镜头"],
			motion: closeUp,
			variants: [conversationalCloseUp],
		},
		edge_peek: {
			description: "从画面边缘斜身探头，先看再转头，轻微打量并眨眼后退回",
			aliases: ["探头偷看", "暗中观察", "扒边"],
			motion: edgePeek,
		},
		spin: {
			description: "轻微蓄力后腾起并转一圈，闭眼微笑，落地缓冲后站稳",
			aliases: ["转圈", "转圈圈", "旋转"],
			motion: spin,
		},
		pout: {
			description: "气鼓鼓地挺胸、别过脸，带嘟嘴和斜睨，随后放松回正",
			aliases: ["嘟嘴", "气鼓鼓", "鼓腮帮"],
			motion: pout,
		},
		panic: {
			description: "慌张地小幅摇头，视线打转，嘴形随紧张节奏起伏",
			aliases: ["慌张", "圈圈眼", "晕乎乎"],
			motion: panic,
		},
		sleepy: {
			description: "困倦地低头打瞌睡，忽然惊醒后摇头眨眼，逐渐恢复精神",
			aliases: ["打瞌睡", "小鸡啄米", "惊醒"],
			motion: sleepy,
		},
		smug_laugh: {
			description: "得意地昂头眯眼，伴随三段笑声式起伏，最后收回笑容",
			aliases: ["大笑", "恶魔笑", "嚯嚯嚯"],
			motion: smugLaugh,
			variants: [conversationalJoy],
		},
	},
};

export function compileMOCatalog(rig: ModelRig): CatalogSnapshot {
	return compileCatalog(MO_MODEL_ID, MO_CATALOG_SOURCE, rig);
}

export function loadCatalog(modelID: string, rig: ModelRig): CatalogSnapshot | undefined {
	if (modelID === MO_MODEL_ID && rig.modelID === MO_MODEL_ID) return compileMOCatalog(rig);
	return undefined;
}
