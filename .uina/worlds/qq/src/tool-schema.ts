// 由 .uina/worlds/qq/tool.json 生成（参数唯一真源），手工修改会被覆盖。
// 重新生成：node scripts/generate-qq-tool-schema.mjs

export const QQ_TOOL_NAME = "qq";

/**
 * 固定认知合同（交互合同 §2 唯一注入面：工具描述只出现一次，不随消息重复）。
 */
export const QQ_TOOL_DESCRIPTION = "QQ是可主动参与的外部世界；普通回复不外发，用speak发送。\n每次调用填写当前account。g<群号>/p<QQ号>/t<QQ号>-g<源群号>是群/私聊/临时会话；u<QQ号>是用户，m消息、a附件、r申请、f事项、o操作。复制返回的短引用，不用名字寻址。\n人物表给出名字与u引用的对应；提醒默认新增，旧消息另标前文。已有现场足够即可行动，不要求例行巡检；合法动作可尝试未知可用性，效果未知则先核验不重发。\nattention只调整提醒，follow_up到期只给查看机会；发送成功不代表对方已读。";

export const QQ_ACTION_SCHEMAS = {
	"observe": {
		"description": "读取缺少的现场、目标或附件；按scope选择内容。",
		"parameters": {
			"oneOf": [
				{
					"type": "object",
					"additionalProperties": false,
					"properties": {
						"scope": {
							"type": "string",
							"const": "overview"
						},
						"account": {}
					},
					"required": [
						"scope"
					]
				},
				{
					"type": "object",
					"additionalProperties": false,
					"properties": {
						"scope": {
							"type": "string",
							"const": "contacts"
						},
						"query": {
							"type": "string",
							"description": "按昵称、备注或用户引用搜索。",
							"minLength": 1
						},
						"limit": {},
						"account": {},
						"cursor": {}
					},
					"required": [
						"scope"
					]
				},
				{
					"type": "object",
					"additionalProperties": false,
					"properties": {
						"scope": {
							"type": "string",
							"const": "groups"
						},
						"query": {
							"type": "string",
							"description": "按群名或群会话引用搜索。",
							"minLength": 1
						},
						"limit": {},
						"account": {},
						"cursor": {}
					},
					"required": [
						"scope"
					]
				},
				{
					"type": "object",
					"additionalProperties": false,
					"properties": {
						"scope": {
							"type": "string",
							"const": "conversations"
						},
						"query": {
							"type": "string",
							"description": "按名称或会话引用搜索；本地条目可能只有引用。",
							"minLength": 1
						},
						"limit": {},
						"kind": {
							"type": "string",
							"enum": [
								"private",
								"group",
								"temp"
							],
							"description": "仅返回指定会话类型；缺省包含全部已知类型。"
						},
						"account": {},
						"cursor": {}
					},
					"required": [
						"scope"
					]
				},
				{
					"type": "object",
					"additionalProperties": false,
					"properties": {
						"scope": {
							"type": "string",
							"const": "conversation"
						},
						"conversationRef": {
							"type": "string",
							"description": "目标会话；复制现场或查询返回的引用。",
							"minLength": 1,
							"pattern": "^(g[1-9][0-9]*|p[1-9][0-9]*|t[1-9][0-9]*(?:-g[1-9][0-9]*)?)$"
						},
						"direction": {
							"type": "string",
							"const": "latest",
							"default": "latest"
						},
						"includeMedia": {
							"type": "boolean",
							"default": false
						},
						"limit": {},
						"cursor": {},
						"includeEvents": {},
						"account": {}
					},
					"required": [
						"scope",
						"conversationRef"
					]
				},
				{
					"type": "object",
					"additionalProperties": false,
					"properties": {
						"scope": {
							"type": "string",
							"const": "conversation"
						},
						"conversationRef": {
							"type": "string",
							"description": "目标会话；复制现场或查询返回的引用。",
							"minLength": 1,
							"pattern": "^(g[1-9][0-9]*|p[1-9][0-9]*|t[1-9][0-9]*(?:-g[1-9][0-9]*)?)$"
						},
						"direction": {
							"type": "string",
							"const": "before"
						},
						"anchorMessageRef": {},
						"includeMedia": {
							"type": "boolean",
							"default": false
						},
						"limit": {},
						"cursor": {},
						"includeEvents": {},
						"account": {}
					},
					"required": [
						"scope",
						"conversationRef",
						"direction",
						"anchorMessageRef"
					]
				},
				{
					"type": "object",
					"additionalProperties": false,
					"properties": {
						"scope": {
							"type": "string",
							"const": "conversation"
						},
						"conversationRef": {
							"type": "string",
							"description": "目标会话；复制现场或查询返回的引用。",
							"minLength": 1,
							"pattern": "^(g[1-9][0-9]*|p[1-9][0-9]*|t[1-9][0-9]*(?:-g[1-9][0-9]*)?)$"
						},
						"direction": {
							"type": "string",
							"const": "after"
						},
						"anchorMessageRef": {},
						"includeMedia": {
							"type": "boolean",
							"default": false
						},
						"limit": {},
						"cursor": {},
						"includeEvents": {},
						"account": {}
					},
					"required": [
						"scope",
						"conversationRef",
						"direction",
						"anchorMessageRef"
					]
				},
				{
					"type": "object",
					"additionalProperties": false,
					"properties": {
						"scope": {
							"type": "string",
							"const": "conversation"
						},
						"conversationRef": {
							"type": "string",
							"description": "目标会话；复制现场或查询返回的引用。",
							"minLength": 1,
							"pattern": "^(g[1-9][0-9]*|p[1-9][0-9]*|t[1-9][0-9]*(?:-g[1-9][0-9]*)?)$"
						},
						"direction": {
							"type": "string",
							"const": "around"
						},
						"anchorMessageRef": {},
						"includeMedia": {
							"type": "boolean",
							"default": false
						},
						"limit": {},
						"cursor": {},
						"includeEvents": {},
						"account": {}
					},
					"required": [
						"scope",
						"conversationRef",
						"direction",
						"anchorMessageRef"
					]
				},
				{
					"type": "object",
					"additionalProperties": false,
					"properties": {
						"scope": {
							"type": "string",
							"const": "messages"
						},
						"messageRefs": {
							"type": "array",
							"items": {
								"type": "string",
								"description": "目标消息；复制返回的消息引用。",
								"minLength": 1,
								"pattern": "^m-?[1-9][0-9]*$"
							},
							"minItems": 1
						},
						"includeMedia": {
							"type": "boolean",
							"default": false
						},
						"account": {}
					},
					"required": [
						"scope",
						"messageRefs"
					]
				},
				{
					"type": "object",
					"additionalProperties": false,
					"properties": {
						"scope": {
							"type": "string",
							"const": "requests"
						},
						"kind": {
							"type": "string",
							"enum": [
								"friend",
								"group_invite",
								"group_join_request"
							]
						},
						"state": {
							"type": "string",
							"enum": [
								"pending",
								"confirmed",
								"unknown",
								"all"
							],
							"default": "pending"
						},
						"limit": {},
						"account": {},
						"cursor": {}
					},
					"required": [
						"scope"
					]
				},
				{
					"type": "object",
					"additionalProperties": false,
					"properties": {
						"scope": {
							"type": "string",
							"const": "attention"
						},
						"target": {
							"oneOf": [
								{
									"type": "string",
									"const": "account"
								},
								{
									"type": "string",
									"description": "目标会话；复制现场或查询返回的引用。",
									"minLength": 1,
									"pattern": "^(g[1-9][0-9]*|p[1-9][0-9]*|t[1-9][0-9]*(?:-g[1-9][0-9]*)?)$"
								}
							]
						},
						"account": {}
					},
					"required": [
						"scope"
					]
				},
				{
					"type": "object",
					"additionalProperties": false,
					"properties": {
						"scope": {
							"type": "string",
							"const": "follow_ups"
						},
						"targetRef": {
							"type": "string",
							"description": "目标会话；复制现场或查询返回的引用。",
							"minLength": 1,
							"pattern": "^(g[1-9][0-9]*|p[1-9][0-9]*|t[1-9][0-9]*(?:-g[1-9][0-9]*)?)$"
						},
						"state": {
							"type": "string",
							"enum": [
								"open",
								"closed",
								"cancelled",
								"all"
							],
							"default": "open"
						},
						"limit": {},
						"account": {},
						"cursor": {}
					},
					"required": [
						"scope"
					]
				},
				{
					"type": "object",
					"additionalProperties": false,
					"properties": {
						"scope": {
							"type": "string",
							"const": "operations"
						},
						"operationRef": {
							"type": "string",
							"description": "已发生操作的引用；查询不会重执行。",
							"minLength": 1,
							"pattern": "^o[1-9][0-9]*$"
						},
						"account": {}
					},
					"required": [
						"scope",
						"operationRef"
					]
				},
				{
					"type": "object",
					"additionalProperties": false,
					"properties": {
						"scope": {
							"type": "string",
							"const": "operations"
						},
						"state": {
							"type": "string",
							"enum": [
								"unknown",
								"recent"
							],
							"default": "unknown"
						},
						"limit": {},
						"cursor": {},
						"account": {}
					},
					"required": [
						"scope"
					]
				},
				{
					"type": "object",
					"additionalProperties": false,
					"properties": {
						"scope": {
							"type": "string",
							"const": "self"
						},
						"includeGroups": {
							"type": "boolean",
							"const": false,
							"default": false
						},
						"account": {}
					},
					"required": [
						"scope"
					]
				},
				{
					"type": "object",
					"additionalProperties": false,
					"properties": {
						"scope": {
							"type": "string",
							"const": "status"
						},
						"account": {}
					},
					"required": [
						"scope"
					]
				},
				{
					"type": "object",
					"additionalProperties": false,
					"properties": {
						"scope": {
							"type": "string",
							"const": "capabilities"
						},
						"action": {
							"type": "string",
							"enum": [
								"observe",
								"speak",
								"gesture",
								"attention",
								"follow_up",
								"account"
							]
						},
						"account": {}
					},
					"required": [
						"scope"
					]
				},
				{
					"type": "object",
					"additionalProperties": false,
					"properties": {
						"scope": {
							"type": "string",
							"const": "expressions"
						},
						"kind": {
							"type": "string",
							"enum": [
								"face",
								"reaction"
							]
						},
						"query": {
							"type": "string",
							"description": "例如：微笑、赞；只返回有真实来源的标识和可用性。",
							"minLength": 1
						},
						"limit": {},
						"cursor": {},
						"account": {}
					},
					"required": [
						"scope",
						"kind"
					]
				},
				{
					"type": "object",
					"additionalProperties": false,
					"properties": {
						"scope": {
							"type": "string",
							"const": "self"
						},
						"includeGroups": {
							"type": "boolean",
							"const": true
						},
						"account": {},
						"limit": {},
						"cursor": {}
					},
					"required": [
						"scope",
						"includeGroups"
					]
				},
				{
					"type": "object",
					"additionalProperties": false,
					"properties": {
						"scope": {
							"type": "string",
							"const": "self"
						},
						"groupConversationRef": {
							"type": "string",
							"minLength": 1,
							"pattern": "^g[1-9][0-9]*$",
							"description": "指定群会话，仅查询自己在该群的名片与角色。"
						},
						"account": {}
					},
					"required": [
						"scope",
						"groupConversationRef"
					]
				},
				{
					"type": "object",
					"additionalProperties": false,
					"properties": {
						"scope": {
							"type": "string",
							"const": "members"
						},
						"conversationRef": {
							"type": "string",
							"minLength": 1,
							"pattern": "^g[1-9][0-9]*$",
							"description": "明确的群会话引用；查询该群成员，不从好友关系推断群成员。"
						},
						"query": {
							"type": "string",
							"description": "按昵称、群名片或QQ号搜索。",
							"minLength": 1
						},
						"limit": {},
						"cursor": {},
						"account": {}
					},
					"required": [
						"scope",
						"conversationRef"
					]
				},
				{
					"type": "object",
					"additionalProperties": false,
					"properties": {
						"scope": {
							"type": "string",
							"const": "content"
						},
						"messageRef": {
							"type": "string",
							"pattern": "^m-?[1-9][0-9]*$",
							"description": "复制消息引用。"
						},
						"segmentIndex": {
							"type": "integer",
							"minimum": 0,
							"description": "现场返回的正文分段位置；从0开始，引用段不计入。"
						},
						"limit": {
							"type": "integer",
							"minimum": 1,
							"description": "卡片/正文按Unicode字符分页默认4096；转发按节点分页默认20。"
						},
						"cursor": {
							"type": "string",
							"minLength": 1,
							"description": "复制同一内容上一页nextCursor。"
						},
						"includeMedia": {
							"type": "boolean",
							"default": false
						},
						"account": {}
					},
					"required": [
						"scope",
						"messageRef",
						"segmentIndex"
					]
				}
			],
			"type": "object",
			"additionalProperties": true,
			"properties": {
				"limit": {
					"type": "integer",
					"minimum": 1,
					"default": 20,
					"description": "页面条数，默认20；conversation单次平台读取最多200，不限制总可读量。"
				},
				"cursor": {
					"type": "string",
					"description": "复制上一页nextCursor；查询条件不变。列表变化时重新查询首页。",
					"minLength": 1
				},
				"includeEvents": {
					"type": "boolean",
					"default": false,
					"description": "同时读取该会话保存的近期事件；不额外触发思考或标记已读。"
				},
				"anchorMessageRef": {
					"type": "string",
					"description": "目标消息；复制返回的消息引用。",
					"minLength": 1,
					"pattern": "^m-?[1-9][0-9]*$"
				},
				"account": {
					"type": "string",
					"pattern": "^[1-9][0-9]*$",
					"description": "当前QQ账号；使用工具说明或现场页首给出的账号。"
				}
			},
			"description": "接不上话题或需核对原文时，可读conversation/messages；图片影响理解时可带includeMedia，查看互动记录可带includeEvents；要@或区分同名成员可查members；想用表情或回应但不确定编码时查expressions；动作效果未知或需核对过去操作时查operations；连接或读取持续异常时查status/capabilities。",
			"required": [
				"account"
			]
		}
	},
	"speak": {
		"description": "向conversationRef发送文字或已有媒体；replyTo指定同会话引用回复。",
		"parameters": {
			"type": "object",
			"additionalProperties": false,
			"properties": {
				"conversationRef": {
					"type": "string",
					"description": "目标会话；复制现场或查询返回的引用。",
					"minLength": 1,
					"pattern": "^(g[1-9][0-9]*|p[1-9][0-9]*|t[1-9][0-9]*(?:-g[1-9][0-9]*)?)$"
				},
				"replyTo": {
					"type": "string",
					"description": "同会话引用；拆批时只给首条可引用消息加引用，纯文件组合不支持。",
					"minLength": 1,
					"pattern": "^m-?[1-9][0-9]*$"
				},
				"content": {
					"type": "array",
					"items": {
						"oneOf": [
							{
								"type": "object",
								"additionalProperties": false,
								"properties": {
									"type": {
										"type": "string",
										"const": "text"
									},
									"text": {
										"type": "string",
										"description": "按原文发送；不解析文本里的 CQ 码。",
										"minLength": 1
									}
								},
								"required": [
									"type",
									"text"
								]
							},
							{
								"type": "object",
								"additionalProperties": false,
								"properties": {
									"type": {
										"type": "string",
										"const": "mention"
									},
									"userRef": {
										"type": "string",
										"description": "目标用户；末段为QQ号，不能代替会话引用。",
										"minLength": 1,
										"pattern": "^u[1-9][0-9]*$"
									}
								},
								"required": [
									"type",
									"userRef"
								]
							},
							{
								"type": "object",
								"additionalProperties": false,
								"properties": {
									"type": {
										"type": "string",
										"const": "face"
									},
									"faceId": {
										"type": "string",
										"description": "复制expressions返回的数字id。",
										"minLength": 1,
										"pattern": "^[0-9]+$"
									}
								},
								"required": [
									"type",
									"faceId"
								]
							},
							{
								"type": "object",
								"additionalProperties": false,
								"properties": {
									"type": {
										"type": "string",
										"const": "image"
									},
									"resource": {}
								},
								"required": [
									"type",
									"resource"
								]
							},
							{
								"type": "object",
								"additionalProperties": false,
								"properties": {
									"type": {
										"type": "string",
										"const": "audio"
									},
									"resource": {}
								},
								"required": [
									"type",
									"resource"
								]
							},
							{
								"type": "object",
								"additionalProperties": false,
								"properties": {
									"type": {
										"type": "string",
										"const": "video"
									},
									"resource": {}
								},
								"required": [
									"type",
									"resource"
								]
							},
							{
								"type": "object",
								"additionalProperties": false,
								"properties": {
									"type": {
										"type": "string",
										"const": "file"
									},
									"resource": {},
									"name": {
										"type": "string",
										"description": "可选平台展示文件名，不是本地路径。",
										"minLength": 1
									}
								},
								"required": [
									"type",
									"resource"
								]
							}
						],
						"type": "object",
						"additionalProperties": true,
						"properties": {
							"resource": {
								"oneOf": [
									{
										"type": "object",
										"additionalProperties": false,
										"properties": {
											"kind": {
												"type": "string",
												"const": "file"
											},
											"path": {
												"type": "string",
												"description": "工具返回的文件路径；须在允许资源根内。",
												"minLength": 1
											}
										},
										"required": [
											"kind",
											"path"
										]
									},
									{
										"type": "object",
										"additionalProperties": false,
										"properties": {
											"kind": {
												"type": "string",
												"const": "qq_media"
											},
											"ref": {
												"type": "string",
												"description": "当前账号拥有的 QQ 媒体引用。",
												"minLength": 1,
												"pattern": "^a[1-9][0-9]*$"
											}
										},
										"required": [
											"kind",
											"ref"
										]
									}
								]
							}
						}
					},
					"minItems": 1
				},
				"account": {
					"type": "string",
					"pattern": "^[1-9][0-9]*$",
					"description": "当前QQ账号；使用工具说明或现场页首给出的账号。"
				}
			},
			"required": [
				"conversationRef",
				"content",
				"account"
			]
		}
	},
	"gesture": {
		"description": "简短互动：react回应指定群消息；poke戳指定会话中的用户。",
		"parameters": {
			"oneOf": [
				{
					"type": "object",
					"additionalProperties": false,
					"properties": {
						"kind": {
							"type": "string",
							"const": "react"
						},
						"messageRef": {
							"type": "string",
							"description": "目标消息；复制返回的消息引用。",
							"minLength": 1,
							"pattern": "^m-?[1-9][0-9]*$"
						},
						"reactionCode": {
							"type": "string",
							"description": "复制expressions返回的数字id，不用文字或Unicode猜编码。",
							"minLength": 1,
							"pattern": "^[0-9]+$"
						},
						"enabled": {
							"type": "boolean",
							"default": true
						},
						"account": {}
					},
					"required": [
						"kind",
						"messageRef",
						"reactionCode"
					]
				},
				{
					"type": "object",
					"additionalProperties": false,
					"properties": {
						"kind": {
							"type": "string",
							"const": "poke"
						},
						"conversationRef": {
							"type": "string",
							"description": "目标会话；复制现场或查询返回的引用。",
							"minLength": 1,
							"pattern": "^(g[1-9][0-9]*|p[1-9][0-9]*|t[1-9][0-9]*(?:-g[1-9][0-9]*)?)$"
						},
						"userRef": {
							"type": "string",
							"description": "目标用户；末段为QQ号，不能代替会话引用。",
							"minLength": 1,
							"pattern": "^u[1-9][0-9]*$"
						},
						"account": {}
					},
					"required": [
						"kind",
						"conversationRef",
						"userRef"
					]
				}
			],
			"properties": {
				"account": {
					"type": "string",
					"pattern": "^[1-9][0-9]*$",
					"description": "当前QQ账号；使用工具说明或现场页首给出的账号。"
				}
			},
			"required": [
				"account"
			],
			"type": "object",
			"additionalProperties": true
		}
	},
	"attention": {
		"description": "会话太吵或暂不想被提醒时，可调整后续提醒；不限制主动查看。",
		"parameters": {
			"oneOf": [
				{
					"type": "object",
					"additionalProperties": false,
					"properties": {
						"operation": {
							"type": "string",
							"const": "set"
						},
						"target": {},
						"mode": {
							"type": "string",
							"enum": [
								"normal",
								"direct_only",
								"silent"
							]
						},
						"priority": {
							"type": "string",
							"enum": [
								"normal",
								"preferred"
							]
						},
						"pausedUntil": {
							"type": [
								"string",
								"null"
							],
							"pattern": "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?(?:Z|[+-]\\d{2}:\\d{2})$",
							"description": "带时区ISO时间；null清除，缺省保持。"
						},
						"account": {}
					},
					"required": [
						"operation",
						"target"
					],
					"anyOf": [
						{
							"type": "object",
							"properties": {
								"mode": {}
							},
							"required": [
								"mode"
							]
						},
						{
							"type": "object",
							"properties": {
								"priority": {}
							},
							"required": [
								"priority"
							]
						},
						{
							"type": "object",
							"properties": {
								"pausedUntil": {}
							},
							"required": [
								"pausedUntil"
							]
						}
					]
				},
				{
					"type": "object",
					"additionalProperties": false,
					"properties": {
						"operation": {
							"type": "string",
							"const": "clear"
						},
						"target": {},
						"account": {}
					},
					"required": [
						"operation",
						"target"
					]
				}
			],
			"type": "object",
			"additionalProperties": true,
			"properties": {
				"target": {
					"oneOf": [
						{
							"type": "string",
							"const": "account"
						},
						{
							"type": "string",
							"description": "目标会话；复制现场或查询返回的引用。",
							"minLength": 1,
							"pattern": "^(g[1-9][0-9]*|p[1-9][0-9]*|t[1-9][0-9]*(?:-g[1-9][0-9]*)?)$"
						}
					]
				},
				"account": {
					"type": "string",
					"pattern": "^[1-9][0-9]*$",
					"description": "当前QQ账号；使用工具说明或现场页首给出的账号。"
				}
			},
			"required": [
				"account"
			]
		}
	},
	"follow_up": {
		"description": "想稍后回到某个话题或事项时保存；reviewAt到期只提醒，不自动执行。",
		"parameters": {
			"oneOf": [
				{
					"type": "object",
					"additionalProperties": false,
					"properties": {
						"operation": {
							"type": "string",
							"const": "create"
						},
						"targetRef": {
							"type": "string",
							"description": "目标会话；复制现场或查询返回的引用。",
							"minLength": 1,
							"pattern": "^(g[1-9][0-9]*|p[1-9][0-9]*|t[1-9][0-9]*(?:-g[1-9][0-9]*)?)$"
						},
						"note": {},
						"evidenceRefs": {},
						"reviewAt": {},
						"account": {}
					},
					"required": [
						"operation",
						"targetRef",
						"note"
					]
				},
				{
					"type": "object",
					"additionalProperties": false,
					"properties": {
						"operation": {
							"type": "string",
							"const": "update"
						},
						"ref": {},
						"note": {},
						"evidenceRefs": {},
						"reviewAt": {},
						"account": {}
					},
					"required": [
						"operation",
						"ref"
					],
					"anyOf": [
						{
							"type": "object",
							"properties": {
								"note": {}
							},
							"required": [
								"note"
							]
						},
						{
							"type": "object",
							"properties": {
								"evidenceRefs": {}
							},
							"required": [
								"evidenceRefs"
							]
						},
						{
							"type": "object",
							"properties": {
								"reviewAt": {}
							},
							"required": [
								"reviewAt"
							]
						}
					]
				},
				{
					"type": "object",
					"additionalProperties": false,
					"properties": {
						"operation": {
							"type": "string",
							"const": "close"
						},
						"ref": {},
						"resolution": {},
						"account": {}
					},
					"required": [
						"operation",
						"ref",
						"resolution"
					]
				},
				{
					"type": "object",
					"additionalProperties": false,
					"properties": {
						"operation": {
							"type": "string",
							"const": "cancel"
						},
						"ref": {},
						"resolution": {},
						"account": {}
					},
					"required": [
						"operation",
						"ref",
						"resolution"
					]
				}
			],
			"type": "object",
			"additionalProperties": true,
			"properties": {
				"note": {
					"type": "string",
					"description": "你想稍后处理的事项。",
					"minLength": 1
				},
				"evidenceRefs": {
					"type": "array",
					"items": {
						"type": "string",
						"description": "证据/资源的稳定引用；不是自动外发授权。",
						"minLength": 1
					},
					"minItems": 0
				},
				"reviewAt": {
					"type": [
						"string",
						"null"
					],
					"pattern": "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?(?:Z|[+-]\\d{2}:\\d{2})$",
					"description": "带时区ISO时间；null清除，缺省保持。"
				},
				"ref": {
					"type": "string",
					"description": "稳定待跟进事项引用。",
					"minLength": 1,
					"pattern": "^f[1-9][0-9]*$"
				},
				"resolution": {
					"type": "string",
					"description": "关闭或取消原因；不表示外部目标已完成。",
					"minLength": 1
				},
				"account": {
					"type": "string",
					"pattern": "^[1-9][0-9]*$",
					"description": "当前QQ账号；使用工具说明或现场页首给出的账号。"
				}
			},
			"required": [
				"account"
			]
		}
	},
	"account": {
		"description": "处理申请、撤回自己的消息、管理未读标记或修改资料；仅执行已授权操作。",
		"parameters": {
			"oneOf": [
				{
					"type": "object",
					"additionalProperties": false,
					"properties": {
						"operation": {
							"type": "string",
							"const": "respond_request"
						},
						"requestRef": {
							"type": "string",
							"description": "实际收到的申请/邀请引用，不接收聊天文字作为申请。",
							"minLength": 1,
							"pattern": "^r[1-9][0-9]*$"
						},
						"decision": {
							"type": "string",
							"enum": [
								"accept",
								"reject"
							]
						},
						"account": {}
					},
					"required": [
						"operation",
						"requestRef",
						"decision"
					]
				},
				{
					"type": "object",
					"additionalProperties": false,
					"properties": {
						"operation": {
							"type": "string",
							"const": "retract"
						},
						"messageRef": {
							"type": "string",
							"description": "目标消息；复制返回的消息引用。",
							"minLength": 1,
							"pattern": "^m-?[1-9][0-9]*$"
						},
						"account": {}
					},
					"required": [
						"operation",
						"messageRef"
					]
				},
				{
					"type": "object",
					"additionalProperties": false,
					"properties": {
						"operation": {
							"type": "string",
							"const": "mark_read"
						},
						"conversationRef": {},
						"account": {}
					},
					"required": [
						"operation",
						"conversationRef"
					]
				},
				{
					"type": "object",
					"additionalProperties": false,
					"properties": {
						"operation": {
							"type": "string",
							"const": "leave_group"
						},
						"conversationRef": {},
						"account": {}
					},
					"required": [
						"operation",
						"conversationRef"
					]
				},
				{
					"type": "object",
					"additionalProperties": false,
					"properties": {
						"operation": {
							"type": "string",
							"const": "remove_contact"
						},
						"userRef": {
							"type": "string",
							"description": "目标用户；末段为QQ号，不能代替会话引用。",
							"minLength": 1,
							"pattern": "^u[1-9][0-9]*$"
						},
						"block": {
							"type": "boolean",
							"default": false
						},
						"account": {}
					},
					"required": [
						"operation",
						"userRef"
					]
				},
				{
					"type": "object",
					"additionalProperties": false,
					"properties": {
						"operation": {
							"type": "string",
							"const": "set_profile"
						},
						"nickname": {
							"type": "string",
							"description": "仅修改自身昵称。",
							"minLength": 1
						},
						"signature": {
							"type": "string",
							"description": "仅修改自身签名；空串表示清空。"
						},
						"account": {}
					},
					"required": [
						"operation"
					],
					"anyOf": [
						{
							"type": "object",
							"properties": {
								"nickname": {}
							},
							"required": [
								"nickname"
							]
						},
						{
							"type": "object",
							"properties": {
								"signature": {}
							},
							"required": [
								"signature"
							]
						}
					]
				},
				{
					"type": "object",
					"additionalProperties": false,
					"properties": {
						"operation": {
							"type": "string",
							"const": "set_avatar"
						},
						"resource": {
							"oneOf": [
								{
									"type": "object",
									"additionalProperties": false,
									"properties": {
										"kind": {
											"type": "string",
											"const": "file"
										},
										"path": {
											"type": "string",
											"description": "工具返回的文件路径；须在允许资源根内。",
											"minLength": 1
										}
									},
									"required": [
										"kind",
										"path"
									]
								},
								{
									"type": "object",
									"additionalProperties": false,
									"properties": {
										"kind": {
											"type": "string",
											"const": "qq_media"
										},
										"ref": {
											"type": "string",
											"description": "当前账号拥有的 QQ 媒体引用。",
											"minLength": 1,
											"pattern": "^a[1-9][0-9]*$"
										}
									},
									"required": [
										"kind",
										"ref"
									]
								}
							]
						},
						"account": {}
					},
					"required": [
						"operation",
						"resource"
					]
				},
				{
					"type": "object",
					"additionalProperties": false,
					"properties": {
						"operation": {
							"type": "string",
							"const": "set_presence"
						},
						"presenceRef": {
							"type": "string",
							"description": "当前未提供映射，set_presence不可用。",
							"minLength": 1,
							"pattern": "^s[1-9][0-9]*$"
						},
						"account": {}
					},
					"required": [
						"operation",
						"presenceRef"
					]
				},
				{
					"type": "object",
					"additionalProperties": false,
					"properties": {
						"operation": {
							"type": "string",
							"const": "set_group_card"
						},
						"conversationRef": {},
						"card": {
							"type": "string",
							"description": "仅设置自己在该群的名片；空串清空。"
						},
						"account": {}
					},
					"required": [
						"operation",
						"conversationRef",
						"card"
					]
				}
			],
			"type": "object",
			"additionalProperties": true,
			"properties": {
				"conversationRef": {
					"type": "string",
					"description": "目标会话；复制现场或查询返回的引用。",
					"minLength": 1,
					"pattern": "^(g[1-9][0-9]*|p[1-9][0-9]*|t[1-9][0-9]*(?:-g[1-9][0-9]*)?)$"
				},
				"account": {
					"type": "string",
					"pattern": "^[1-9][0-9]*$",
					"description": "当前QQ账号；使用工具说明或现场页首给出的账号。"
				}
			},
			"required": [
				"account"
			]
		}
	}
} as const;
