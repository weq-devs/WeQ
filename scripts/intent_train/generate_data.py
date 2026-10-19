# -*- coding: utf-8 -*-
"""
QWeQ-NineBird 数据集生成与语料库构建脚本
生成覆盖 17 种意图、15 种情绪以及丰富上下文对比样本的结构化训练集。
"""

import json
import os
import random

INTENT_CLASSES = [
    "question", "request", "greeting", "share", "praise",
    "vent", "joke", "plan", "info", "chat",
    "boast", "flattery", "banter", "perfunctory", "gossip", "coquetry", "other"
]

EMOTION_CLASSES = [
    "joy", "excitement", "admiration", "neutral", "sadness",
    "anger", "anxiety", "affection", "fatigue", "curiosity",
    "shock", "aggrieved", "irony", "anticipation", "embarrassed"
]

def format_sample(text, context_list=None, intent="chat", emotion="neutral", intensity=50, sentiment=0):
    """
    context_list: list of dict(mine=bool, text=str, gap_sec=int)
    """
    parts = []
    if context_list:
        for c in context_list:
            speaker = "我" if c.get("mine", False) else "对方"
            gap = c.get("gap_sec", 30)
            if gap <= 60:
                tag = "刚刚"
            elif gap <= 300:
                tag = "几分钟前"
            elif gap <= 600:
                tag = "十分钟内"
            else:
                tag = "久远"
            parts.append(f"上文[{tag}]: {speaker}: {c['text']}")
    
    ctx_str = " | ".join(parts) if parts else ""
    if ctx_str:
        formatted = f"{ctx_str} [SEP] 消息: {text}"
    else:
        formatted = f"消息: {text}"

    return {
        "text": text,
        "context": context_list or [],
        "formatted_input": formatted,
        "intent": intent,
        "emotion": emotion,
        "intensity": intensity,
        "sentiment": sentiment
    }

def generate_base_dataset():
    samples = []

    # 1. 【核心对比】上文牛逼成果 vs 吓哭了 / 看傻了 / 给跪了 / 卧槽 / 逆天
    achievement_contexts = [
        "我这自研核心算法重构完跑通了，性能提升100倍！",
        "刚收到邮件，论文被CVPR顶会录用了，还是Oral！",
        "终于把这个历史遗留架构重构完毕，无缝上线零报错！",
        "单刷无伤通关了最高难度隐藏Boss，破了全服纪录！",
        "今天抽卡双黄蛋，直接抽齐满命满精毕业了！",
        "公司发年终奖了，今年拿了S+绩效外加顶格期权！",
        "手搓了一个纯 Rust 编写的微秒级网关，压测直接打满几百万QPS！",
        "全省比赛拿了特等奖第一名，奖杯刚到手！",
        "看我用纯CSS手画的这套动态光影，完全没用图片！",
        "自制独立游戏上线首日Steam热销榜前十，评价好评如潮！"
    ]

    awe_reactions = [
        ("吓哭了", "praise", "admiration", 88, 85),
        ("直接给我看哭了", "praise", "admiration", 86, 85),
        ("看傻了，这是人类能做出来的？", "praise", "admiration", 90, 88),
        ("给大佬跪了，收下我的膝盖！", "praise", "admiration", 92, 90),
        ("恐怖如斯，简直人形外挂！", "praise", "admiration", 90, 85),
        ("太变态了吧这性能，神仙下凡！", "praise", "admiration", 88, 86),
        ("卧槽！逆天！真假？！", "praise", "admiration", 85, 82),
        ("头皮发麻，膜拜巨佬！", "praise", "admiration", 90, 88),
        ("纯纯怪物，大佬受我一拜！", "flattery", "admiration", 92, 90),
        ("太权威了，这是什么神级操作！", "flattery", "admiration", 90, 88),
        ("牛逼plus！太顶了！", "praise", "admiration", 85, 85),
        ("666666，不愧是你！", "praise", "admiration", 82, 80),
        ("封神！直接原地封神！", "praise", "admiration", 92, 90),
        ("这是什么仙品细糠，太强了！", "flattery", "admiration", 88, 86),
        ("目瞪口呆，瞳孔地震！", "praise", "shock", 85, 80)
    ]

    for ctx in achievement_contexts[:4]:
        for rx, it, em, inten, sent in awe_reactions[:10]:
            # 正常新鲜时间窗口（30秒 - 3分钟内） -> 判定为夸赞/吹捧 + 赞叹
            samples.append(format_sample(
                rx,
                [{"mine": False, "text": ctx, "gap_sec": random.randint(15, 180)}],
                intent=it, emotion=em, intensity=inten, sentiment=sent
            ))

    # 1b. 【关键平衡】上文是成果/日常分享，但下文是普通追问/普通闲聊/收到确认（绝不能因为有上文就盲目判成夸赞！）
    normal_followups = [
        ("是用哪个分支编译的？", "question", "curiosity", 45, 10),
        ("耗时大概多少毫秒？", "question", "curiosity", 45, 5),
        ("好的，知道了。", "chat", "neutral", 25, 5),
        ("收到，我一会儿拉下来跑一下。", "info", "neutral", 35, 15),
        ("嗯嗯，看到群里通知了。", "chat", "neutral", 30, 5),
        ("顺便帮我把配置文件也发一下吧。", "request", "neutral", 45, 10),
        ("那今天下午三点我们一起测一下。", "plan", "neutral", 50, 30),
        ("我这边还在编译，稍微等我两分钟。", "info", "neutral", 35, 0),
        ("原来是改了这里啊，明白了。", "chat", "neutral", 35, 10),
        ("行，先这样吧。", "chat", "neutral", 25, 0),
    ]
    for ctx in achievement_contexts[:6]:
        for rx, it, em, inten, sent in normal_followups:
            samples.append(format_sample(
                rx,
                [{"mine": False, "text": ctx, "gap_sec": random.randint(15, 180)}],
                intent=it, emotion=em, intensity=inten, sentiment=sent
            ))

    # 2. 【时效性过期对比】上文成果隔了 2 小时甚至 1 天 -> 上文时效已过，当前「吓哭了」回归真实恐惧/焦虑
    for ctx in achievement_contexts[:5]:
        samples.append(format_sample(
            "吓哭了",
            [{"mine": False, "text": ctx, "gap_sec": 7200}], # 2小时前
            intent="vent", emotion="anxiety", intensity=75, sentiment=-60
        ))
        samples.append(format_sample(
            "看傻了",
            [{"mine": False, "text": ctx, "gap_sec": 3600}],
            intent="vent", emotion="shock", intensity=70, sentiment=-40
        ))

    # 3. 【真实惊恐/危险对比】上文真实恐怖危险/虫蛇事故 -> 吓哭了是真害怕
    horror_contexts = [
        "刚才半夜走夜路，背后一直有脚步声尾随我，吓得我一路狂奔进便利店！",
        "家里洗手间刚刚爬出来一只巴掌大的大蜘蛛和大蟑螂！",
        "刚才回来的路上高架桥发生连环追尾车祸，车头都撞扁了，太惊险了！",
        "刚才看那个泰国恐怖片鬼影，突然一个高能鬼脸贴脸暴击！",
        "半夜一个人在家，走廊突然传来敲门声和指甲刮门的声音！"
    ]
    for ctx in horror_contexts:
        samples.append(format_sample(
            "吓哭了",
            [{"mine": False, "text": ctx, "gap_sec": random.randint(20, 120)}],
            intent="chat", emotion="anxiety", intensity=85, sentiment=-70
        ))
        samples.append(format_sample(
            "救命啊，吓死我了，太恐怖了！",
            [{"mine": False, "text": ctx, "gap_sec": random.randint(20, 120)}],
            intent="vent", emotion="anxiety", intensity=88, sentiment=-75
        ))
        samples.append(format_sample(
            "头皮发麻，光听你描述我就汗毛倒立了！",
            [{"mine": False, "text": ctx, "gap_sec": random.randint(20, 120)}],
            intent="chat", emotion="anxiety", intensity=80, sentiment=-65
        ))

    daily_contexts = [
        {"mine": False, "text": "你现在在干嘛呢？", "gap_sec": 30},
        {"mine": True, "text": "刚吃完午饭，准备休息一会儿。", "gap_sec": 45},
        {"mine": False, "text": "今天群里的消息你看了吗？", "gap_sec": 60},
        {"mine": True, "text": "下午有个需求评审会别忘了。", "gap_sec": 120},
    ]

    def append_with_contexts(text, intent, emotion, intensity, sentiment):
        samples.append(format_sample(text, intent=intent, emotion=emotion, intensity=intensity, sentiment=sentiment))
        ctx = random.choice(daily_contexts)
        samples.append(format_sample(text, [ctx], intent=intent, emotion=emotion, intensity=intensity, sentiment=sentiment))

    # 4. 【炫耀 boast】
    boast_texts = [
        ("终于抽到满命专武了，看看我的神级面板！", 85, 80),
        ("自研重构的全新底层系统上线，扛住了百万QPS，零差错！", 88, 85),
        ("刚拿到了鹅厂特批SP offer，总包薪资直接翻倍！", 90, 85),
        ("提车了兄弟们！终于提了心心念念的爱车！", 85, 80),
        ("单抽一发入魂出金，手气也就一般般吧（战术后仰）", 80, 75),
        ("全服第一击杀成就达成，截图留念！", 88, 85),
        ("随便写了个小工具开源，三天破了2000 Star！", 85, 80),
        ("来看看我的全新电竞桌面搭建，这光污染帅不帅？", 78, 75),
        ("托福一次考了115，总算不用再刷分了！", 85, 80),
        ("今天打卡深渊12层满星，顺便带公会萌新过了全本！", 80, 75)
    ]
    for text, inten, sent in boast_texts:
        append_with_contexts(text, "boast", "excitement", inten, sent)

    # 5. 【吹捧 flattery】
    flattery_texts = [
        ("大佬受我一拜，代码写得太权威了，真是仙品细糠！", 90, 88),
        ("膜拜巨佬！每次看你的架构设计都是一种享受！", 88, 85),
        ("巨佬带带我，疯狂为你打call！", 85, 82),
        ("太强了太强了，不愧是团队顶梁柱，永远的神！", 88, 85),
        ("这简直就是神仙下凡，我等凡人只能跪着仰望！", 90, 88),
        ("大佬出品，必属精品，跟着大佬有肉吃！", 82, 80),
        ("太权威了，这篇文档写得堪称教科书级别！", 85, 82),
        ("无脑吹爆！世界上怎么会有这么完美的方案！", 88, 85)
    ]
    for text, inten, sent in flattery_texts:
        append_with_contexts(text, "flattery", "admiration", inten, sent)

    # 6. 【调侃 / 互怼 banter】
    banter_texts = [
        ("就这啊？你小子差不多得了，夺笋啊！", 75, 50),
        ("损不损啊你，小丑竟是我自己是吧？", 78, 55),
        ("很难评，祝你成功吧，典中典发言！", 72, 45),
        ("原来是个弟中弟，刚才吹那么大声我还以为多厉害呢哈哈！", 76, 60),
        ("你听听你说的这是人话吗？损友石锤了！", 75, 55),
        ("夺笋呐，熊猫的笋都被你夺完了！", 72, 50),
        ("笑死，你直接报我身份证号得了！", 76, 65),
        ("差不多得了，再装逼雷公都要劈你了！", 75, 50)
    ]
    for text, inten, sent in banter_texts:
        append_with_contexts(text, "banter", "joy", inten, sent)

    # 7. 【敷衍 / 反讽 perfunctory + irony】
    perfunctory_texts = [
        ("啊对对对，你全对，行了吧？", 75, -50),
        ("行行行，好好好，你开心就好。", 70, -45),
        ("昂对对对，真是谢谢你全家啊。", 75, -55),
        ("哦哦，知道了，已读乱回，随便吧。", 65, -35),
        ("行吧，大可不必跟我解释这么多。", 68, -40),
        ("那我真是太谢谢你了呢，栓Q！", 78, -50),
        ("啊是是是，你最厉害，给你鼓掌啪啪啪。", 75, -52),
        ("好的好的，敷衍一下，不用再说了。", 65, -35)
    ]
    for text, inten, sent in perfunctory_texts:
        append_with_contexts(text, "perfunctory", "irony", inten, sent)

    # 8. 【吃瓜 gossip + curiosity】
    gossip_texts = [
        ("尊嘟假嘟？快求细说！", 78, 40),
        ("细说！搬小板凳前排吃瓜了！", 80, 45),
        ("怎么个事？还有这种反转？蹲一个后续！", 75, 35),
        ("有瓜？速速借一部说话！", 76, 40),
        ("什么情况什么情况？快讲讲到底咋回事！", 80, 35),
        ("真的假的？我靠速发链接让我开开眼！", 78, 45),
        ("前排围观，坐等当事人出面回应！", 72, 30),
        ("展开讲讲，不要逼我求你！", 75, 35)
    ]
    for text, inten, sent in gossip_texts:
        append_with_contexts(text, "gossip", "curiosity", inten, sent)

    # 9. 【撒娇 coquetry + affection】
    coquetry_texts = [
        ("好哥哥带带我嘛呜呜呜，求求你了！", 82, 75),
        ("嘤嘤嘤，帮帮人家嘛，给你买奶茶好不好！", 80, 72),
        ("呜呜呜要抱抱，今天被老板骂惨了求安慰！", 85, 70),
        ("好不好嘛，就帮我这一回嘛，贴贴你！", 82, 75),
        ("求求你了尊嘟很需要你，给你比心心！", 78, 72),
        ("哥哥最好了，天下第一好，求带飞！", 85, 78),
        ("哼，不理你了，除非你给我买冰淇淋！", 75, 65)
    ]
    for text, inten, sent in coquetry_texts:
        append_with_contexts(text, "coquetry", "affection", inten, sent)

    # 10. 【委屈 aggrieved / 低落 sadness / 生气 anger】
    aggrieved_texts = [
        ("太欺负人了，好委屈，凭什么每次背锅的都是我！", "vent", "aggrieved", 85, -70),
        ("心里好难受，明明不是我的问题还被骂了一顿呜呜！", "vent", "aggrieved", 82, -68),
        ("委屈巴拉，心态真的搞崩了，好想哭！", "vent", "aggrieved", 85, -72),
        ("凭什么啊，我辛辛苦苦做完了方案结果功劳被别人抢了！", "vent", "aggrieved", 88, -75),
        ("今天被搞了，莫名其妙扣绩效，太委屈了！", "vent", "aggrieved", 82, -70),
        ("唉，今天心情真的好低落，什么都不想干。", "vent", "sadness", 65, -55),
        ("难受，准备了这么久的考试还是差了两分没过。", "vent", "sadness", 72, -60),
        ("气死我了！这破接口文档全是错的，白白浪费我一下午！", "vent", "anger", 85, -75),
        ("真的火大，明明说好不改需求的又临时推翻重来！", "vent", "anger", 82, -70),
    ]
    for text, it, em, inten, sent in aggrieved_texts:
        append_with_contexts(text, it, em, inten, sent)

    # 11. 【期待 anticipation】
    anticipation_texts = [
        ("急急急！到底什么时候出啊，我一秒钟都等不及了！", 85, 65),
        ("太期待了！坐等今晚八点准时发售！", 82, 75),
        ("摩拳擦掌，等这个版本更新等了整整大半年了！", 80, 70),
        ("迫不及待想看下一集了，快点端上来吧！", 82, 68),
        ("好期待明天的春游，晚上兴奋得睡不着觉！", 78, 75)
    ]
    for text, inten, sent in anticipation_texts:
        append_with_contexts(text, "chat", "anticipation", inten, sent)

    # 12. 【尴尬 embarrassed】
    embarrassed_texts = [
        ("尬住了，在电梯里认错人还大声打了招呼，太尴尬了！", 80, -45),
        ("社死现场！脚趾已经抠出三室一厅了！", 85, -50),
        ("无地自容，发错大群还撤不回来了，救命！", 82, -55),
        ("太尴尬了，开麦以为静音了，结果打嗝全被听到了！", 80, -40),
        ("窒息，当着暗恋对象的面摔了个大马趴，社死瞬间！", 85, -50)
    ]
    for text, inten, sent in embarrassed_texts:
        append_with_contexts(text, "vent", "embarrassed", inten, sent)

    # 13. 【狂喜玩梗 joke + joy】
    joke_texts = [
        ("笑死我了，蚌埠住了，怎么能这么沙雕！", 82, 80),
        ("哈哈哈哈哈哈笑发财了，夺笋呐！", 85, 82),
        ("给我整笑了，233333333333！", 78, 75),
        ("笑裂开了，这一段直接封神，笑得我肚子疼！", 82, 80),
        ("笑得在床上打滚，笑死人不偿命！", 80, 78),
        ("哈哈哈这图太逗了，我存表情包了！", 72, 75),
        ("哈哈哈哈笑哭，怎么会有这么离谱的操作", 75, 72)
    ]
    for text, inten, sent in joke_texts:
        append_with_contexts(text, "joke", "joy", inten, sent)

    # 14. 【疲惫吐槽 vent + fatigue】
    fatigue_texts = [
        ("人麻了，连轴转加了三天班，现在纯纯行尸走肉。", 80, -65),
        ("CPU干烧了，累死我了，不想动弹。", 75, -60),
        ("电量耗尽，纯纯牛马，已老实求放过。", 78, -62),
        ("困死，早八人的绝望谁懂啊，只想躺平。", 72, -55),
        ("燃尽了，考完四级脑浆都摇匀了，毁灭吧。", 76, -58)
    ]
    for text, inten, sent in fatigue_texts:
        append_with_contexts(text, "vent", "fatigue", inten, sent)

    # 15. 【温情示好 chat + affection】
    affection_texts = [
        ("天冷了多穿点衣服，晚上回去早点休息，照顾好自己呀。", 65, 80),
        ("辛苦啦！给你点了热奶茶外卖，一会儿记得拿！", 70, 85),
        ("摸摸头，今天很棒了，一切都会好起来的，抱抱你！", 75, 82),
        ("看到这件衣服觉得特别适合你，就顺手给你带了一件！", 68, 78),
        ("乖，不要难过了，有我在呢，随时听你倾诉。", 72, 80)
    ]
    for text, inten, sent in affection_texts:
        append_with_contexts(text, "chat", "affection", inten, sent)

    # 16. 【提问与请求 question / request】
    question_texts = [
        ("请问这个报错是什么原因？怎么配置端口转发？", "question", "curiosity", 55, 10),
        ("请问明天开会是线上还是线下？具体几点开始？", "question", "neutral", 40, 0),
        ("有人知道公司附近哪里有打印店吗？急用！", "question", "anxiety", 60, -10),
        ("为什么我本地跑代码正常，一到测试环境就报502？", "question", "curiosity", 65, -15),
        ("这个API接口的签名参数是怎么计算出来的？有文档吗？", "question", "curiosity", 55, 10),
        ("请问这次版本升级会影响现有的历史数据吗？", "question", "neutral", 50, 0),
        ("大家平时都用什么工具画架构图啊？求推荐！", "question", "curiosity", 55, 20),
        ("有没有懂前端的大佬？这个CSS水平居中怎么搞？", "question", "curiosity", 55, 10),
        ("你那个脚本跑完了吗？结果怎么样？", "question", "curiosity", 45, 5),
        ("中午去哪吃饭？去不去三楼食堂？", "question", "neutral", 40, 10),
        ("这个配置项应该填什么地址？", "question", "neutral", 40, 0),
        ("大佬能帮忙看下这个SQL慢查询怎么优化吗？", "request", "curiosity", 60, 20),
        ("麻烦顺路帮我带一份食堂的盖浇饭可以吗，谢谢！", "request", "neutral", 50, 30),
        ("你有空帮我 Review 一下这个分支的代码吗？", "request", "neutral", 50, 20),
        ("能不能帮我把最新的安装包打包发一份？我权限不够。", "request", "neutral", 55, 10),
        ("麻烦你把昨天的会议纪要同步给我一份，谢谢！", "request", "neutral", 45, 15),
        ("可以发一下刚才屏幕上展示的那份PPT吗？", "request", "neutral", 45, 20),
        ("求助！电脑突然蓝屏了，有人会修系统引导吗？", "request", "anxiety", 75, -30),
        ("帮我点个拼多多砍一刀吧，还差最后0.01元！", "request", "joy", 60, 40)
    ]
    for text, it, em, inten, sent in question_texts:
        append_with_contexts(text, it, em, inten, sent)

    # 17. 【约定与约定响应 plan + excitement/neutral】
    plan_texts = [
        ("包的！周六晚上七点老地方烧烤摊不见不散，搞起！", "plan", "excitement", 80, 75),
        ("安排！明天下午两点会议室碰头，冲冲冲！", "plan", "excitement", 75, 70),
        ("好的，那一言为定，到时车库碰头。", "plan", "neutral", 50, 40),
        ("妥妥的，周末一起去爬山徒步！", "plan", "excitement", 75, 70),
        ("下周三晚上一起去吃海底捞吧，我提前订位子！", "plan", "excitement", 70, 65),
        ("那就这么定了，明早九点高铁站集合，别迟到哦！", "plan", "neutral", 60, 50),
        ("收到，明天上午十点我们准时过方案。", "plan", "neutral", 45, 30),
        ("走起走起！今天下班必须打几把游戏放松一下！", "plan", "excitement", 80, 75)
    ]
    for text, it, em, inten, sent in plan_texts:
        append_with_contexts(text, it, em, inten, sent)

    # 18. 【日常问候与通知 greeting / info / share / chat / other】
    greeting_info_texts = [
        ("早安呀！新的一天元气满满！", "greeting", "joy", 60, 70),
        ("哈喽哈喽，晚上好！吃过晚饭了吗？", "greeting", "neutral", 45, 40),
        ("中午好，午休时间到，大家注意劳逸结合！", "greeting", "neutral", 45, 50),
        ("大家周末愉快呀！", "greeting", "joy", 60, 75),
        ("嗨，在吗？", "greeting", "neutral", 35, 15),
        ("早上好！", "greeting", "joy", 50, 55),
        ("通知：今晚12点机房例行维护，预计停机半小时。", "info", "neutral", 30, 0),
        ("各位同事，本周周报请在下午五点前提交完毕。", "info", "neutral", 35, 0),
        ("HR通知：下周一开始全员实行冬令时作息时间。", "info", "neutral", 40, 10),
        ("班车时刻表更新了，最新班次已上传到群文件。", "info", "neutral", 35, 0),
        ("我已经把代码推到 dev 分支了，测试通过。", "info", "neutral", 35, 15),
        ("刚才那个小问题已经修好了，重启一下就能生效。", "info", "neutral", 35, 20),
        ("文件我已经发你邮箱了，注意查收一下。", "info", "neutral", 35, 15),
        ("分享一个最近发现的超实用VS Code插件，提效神器！", "share", "joy", 65, 60),
        ("推荐一部最近看的科幻电影，剧情反转太精彩了！", "share", "excitement", 70, 75),
        ("我把今天踩坑排错的完整笔记发在博客上了，供大家参考。", "share", "neutral", 50, 40),
        ("给你看张今天路边拍到的晚霞，超好看。", "share", "joy", 60, 65),
        ("把这个开源仓库链接发群里，大家平时可能用得上。", "share", "neutral", 45, 35),
        ("今天天气真好，蓝天白云让人心情舒畅。", "chat", "joy", 50, 65),
        ("原来是这样啊，明白了。", "chat", "neutral", 30, 10),
        ("好的，收到。", "chat", "neutral", 25, 10),
        ("嗯嗯，没问题。", "chat", "neutral", 25, 10),
        ("好的收到", "chat", "neutral", 20, 5),
        ("我正在看这个文件呢。", "chat", "neutral", 30, 5),
        ("刚才去拿了个快递，刚回工位。", "chat", "neutral", 30, 5),
        ("今天中午食堂的红烧肉还挺好吃的。", "chat", "joy", 45, 40),
        ("好像确实是这么回事。", "chat", "neutral", 30, 5),
        ("我先试一下看看效果。", "chat", "neutral", 35, 10),
        ("平时我也差不多是这个时间睡。", "chat", "neutral", 30, 5),
        ("哈哈是的，我也发现了。", "chat", "joy", 45, 35),
        ("1", "other", "neutral", 10, 0),
        ("？", "other", "curiosity", 30, 0),
        ("...", "other", "neutral", 20, -10),
        ("[图片]", "other", "neutral", 20, 0),
        ("[表情]", "other", "joy", 30, 20)
    ]
    for text, it, em, inten, sent in greeting_info_texts:
        append_with_contexts(text, it, em, inten, sent)

    return samples

def main():
    os.makedirs("scripts/intent_train", exist_ok=True)
    samples = generate_base_dataset()
    random.seed(42)
    random.shuffle(samples)

    out_path = "scripts/intent_train/train_data.json"
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(samples, f, ensure_ascii=False, indent=2)

    print(f"Generated {len(samples)} training samples saved to {out_path}")
    
    # 统计分布
    intent_counts = {}
    emotion_counts = {}
    for s in samples:
        intent_counts[s["intent"]] = intent_counts.get(s["intent"], 0) + 1
        emotion_counts[s["emotion"]] = emotion_counts.get(s["emotion"], 0) + 1
    
    print("Intent distribution:", json.dumps(intent_counts, ensure_ascii=False, indent=2))
    print("Emotion distribution:", json.dumps(emotion_counts, ensure_ascii=False, indent=2))

if __name__ == "__main__":
    main()
