import type { StyleProfileV1 } from "@something-to-tell/contracts/style-system";

export type StyleContentLocale = "en" | "ru";
export type StyleProfileDraft = Pick<
  StyleProfileV1,
  "name" | "description" | "guidance" | "traits" | "positive_examples"
>;

export interface StylePreset {
  id: string;
  draft: StyleProfileDraft;
}

interface LocalizedStylePreset {
  id: string;
  content: Record<StyleContentLocale, StyleProfileDraft>;
}

/** Application-owned templates are copied into projects and never become hidden authorities. */
const STYLE_PRESETS: LocalizedStylePreset[] = [
  {
    id: "balanced-narrative",
    content: {
      en: {
        name: "Balanced narrative",
        description: "Clear, versatile prose for general narrative scenes.",
        guidance: "Use concrete language and readable sentence structures. Balance action, observation, and interior response. Preserve every authored fact and avoid decorative detail that does not advance mood, character, or action.",
        traits: {
          traits_version: 1,
          tone: ["clear", "grounded"],
          rhythm: ["varied sentences"],
          pacing: ["measured"],
          vocabulary: ["concrete", "accessible"],
          dramatic_intensity: "moderate"
        },
        positive_examples: ["Mara checked the seal, then slipped the ledger beneath her coat."]
      },
      ru: {
        name: "Сбалансированное повествование",
        description: "Ясная универсальная проза для большинства повествовательных сцен.",
        guidance: "Используй конкретные формулировки и легко читаемые предложения. Сохраняй баланс между действием, наблюдением и внутренней реакцией. Не изменяй авторские факты и не добавляй украшения, которые не развивают настроение, персонажа или действие.",
        traits: {
          traits_version: 1,
          tone: ["ясный", "приземлённый"],
          rhythm: ["разнообразные предложения"],
          pacing: ["размеренный"],
          vocabulary: ["конкретная", "доступная"],
          dramatic_intensity: "умеренная"
        },
        positive_examples: ["Мара проверила печать и спрятала журнал под плащ."]
      }
    }
  },
  {
    id: "cinematic-tension",
    content: {
      en: {
        name: "Cinematic tension",
        description: "Visual, immediate prose for danger, pursuit, and confrontation.",
        guidance: "Foreground physical action, spatial clarity, and sensory cues with narrative consequence. Shorten beats as pressure rises. Keep the camera close to the active viewpoint and preserve all names, quantities, states, and causal facts.",
        traits: {
          traits_version: 1,
          tone: ["tense", "immediate"],
          rhythm: ["short accelerating beats"],
          pacing: ["fast"],
          vocabulary: ["visual", "physical"],
          dramatic_intensity: "high"
        },
        positive_examples: ["The lock snapped. Footsteps struck the stair before Ilya could turn."]
      },
      ru: {
        name: "Кинематографическое напряжение",
        description: "Зримая динамичная проза для опасности, погони и конфликта.",
        guidance: "Выдвигай на первый план физическое действие, понятное пространство и значимые чувственные детали. Укорачивай ритмические отрезки по мере роста напряжения. Держись рядом с активной точкой зрения и сохраняй все имена, количества, состояния и причинные факты.",
        traits: {
          traits_version: 1,
          tone: ["напряжённый", "непосредственный"],
          rhythm: ["короткие ускоряющиеся фразы"],
          pacing: ["быстрый"],
          vocabulary: ["зримая", "физическая"],
          dramatic_intensity: "высокая"
        },
        positive_examples: ["Замок лопнул. Шаги ударили по лестнице раньше, чем Илья успел обернуться."]
      }
    }
  },
  {
    id: "literary-introspection",
    content: {
      en: {
        name: "Literary introspection",
        description: "Reflective, image-rich prose centered on character perception.",
        guidance: "Develop precise inner observation through restrained imagery and meaningful sensory association. Let sentence rhythm follow thought without obscuring action or causality. Do not invent memories, motives, or world facts absent from the source.",
        traits: {
          traits_version: 1,
          tone: ["reflective", "intimate"],
          rhythm: ["flowing with deliberate pauses"],
          pacing: ["slow"],
          vocabulary: ["evocative", "precise"],
          dramatic_intensity: "restrained"
        },
        positive_examples: ["The harbor lights trembled in the ledger's wax, as if the city doubted its own signature."]
      },
      ru: {
        name: "Литературная интроспекция",
        description: "Рефлексивная образная проза, сосредоточенная на восприятии персонажа.",
        guidance: "Раскрывай точные внутренние наблюдения через сдержанные образы и значимые чувственные ассоциации. Подчиняй ритм предложения движению мысли, не скрывая действие и причинность. Не придумывай отсутствующие в исходнике воспоминания, мотивы или факты мира.",
        traits: {
          traits_version: 1,
          tone: ["рефлексивный", "интимный"],
          rhythm: ["плавный с осмысленными паузами"],
          pacing: ["медленный"],
          vocabulary: ["образная", "точная"],
          dramatic_intensity: "сдержанная"
        },
        positive_examples: ["Огни гавани дрожали в воске печати, будто город сомневался в собственной подписи."]
      }
    }
  },
  {
    id: "light-comedy",
    content: {
      en: {
        name: "Light comedy",
        description: "Warm, agile prose driven by timing and character contrast.",
        guidance: "Build humor from situation, timing, and established character behavior. Prefer concise setups and clean turns over explanatory punchlines. Keep stakes legible, avoid ridicule that contradicts the source tone, and preserve every narrative fact.",
        traits: {
          traits_version: 1,
          tone: ["warm", "wry"],
          rhythm: ["crisp setup and turn"],
          pacing: ["brisk"],
          vocabulary: ["playful", "plainspoken"],
          dramatic_intensity: "light"
        },
        positive_examples: ["Ilya produced the key with a flourish. It opened the broom cupboard."]
      },
      ru: {
        name: "Лёгкая комедия",
        description: "Тёплая подвижная проза, основанная на ритме и контрасте персонажей.",
        guidance: "Строй юмор на ситуации, точном моменте и уже заданном поведении персонажей. Предпочитай короткую подготовку и ясный поворот объяснению шутки. Сохраняй понятность ставок, не вводи насмешку вопреки исходному тону и не изменяй факты истории.",
        traits: {
          traits_version: 1,
          tone: ["тёплый", "ироничный"],
          rhythm: ["чёткая подготовка и поворот"],
          pacing: ["бодрый"],
          vocabulary: ["игривая", "разговорная"],
          dramatic_intensity: "лёгкая"
        },
        positive_examples: ["Илья эффектно предъявил ключ. Ключ открыл кладовку со швабрами."]
      }
    }
  },
  {
    id: "gothic-horror",
    content: {
      en: {
        name: "Gothic horror",
        description: "Brooding, atmospheric prose shaped by decay, secrecy, and inherited dread.",
        guidance: "Build unease through architecture, weather, silence, and traces of the past. Let setting reflect emotional pressure without becoming decorative. Reveal threats indirectly, sustain ambiguity, and preserve every authored fact, relationship, and cause.",
        traits: {
          traits_version: 1,
          tone: ["brooding", "ominous"],
          rhythm: ["measured with lingering clauses"],
          pacing: ["slow-burn"],
          vocabulary: ["sensory", "antique", "restrained"],
          dramatic_intensity: "gathering"
        },
        positive_examples: ["Rain threaded the ruined chapel, and something behind the sealed door answered each drop."]
      },
      ru: {
        name: "Готический хоррор",
        description: "Мрачная атмосферная проза об упадке, тайнах и унаследованном страхе.",
        guidance: "Создавай тревогу через архитектуру, погоду, тишину и следы прошлого. Пусть окружение отражает эмоциональное давление, но не превращается в декорацию ради декорации. Показывай угрозу косвенно, сохраняй неоднозначность и не изменяй авторские факты, отношения и причины.",
        traits: {
          traits_version: 1,
          tone: ["мрачный", "зловещий"],
          rhythm: ["размеренный с протяжёнными фразами"],
          pacing: ["медленно нарастающий"],
          vocabulary: ["чувственная", "старинная", "сдержанная"],
          dramatic_intensity: "нарастающая"
        },
        positive_examples: ["Дождь прошивал разрушенную часовню, и за запертой дверью что-то отвечало каждой капле."]
      }
    }
  },
  {
    id: "cosmic-horror",
    content: {
      en: {
        name: "Cosmic horror",
        description: "Vast, disorienting horror centered on unknowable forces and fragile certainty.",
        guidance: "Contrast ordinary human perception with implications too large or alien to resolve. Prefer precise anomalies and incomplete patterns over exhaustive explanation. Keep the viewpoint comprehensible, avoid inventing cosmology, and preserve all established entities and events.",
        traits: {
          traits_version: 1,
          tone: ["uncanny", "awe-struck", "fatalistic"],
          rhythm: ["controlled sentences breaking under revelation"],
          pacing: ["escalating discovery"],
          vocabulary: ["precise", "estranging", "spare"],
          dramatic_intensity: "overwhelming"
        },
        positive_examples: ["The signal repeated her name, though it had begun its journey before her species learned to speak."]
      },
      ru: {
        name: "Космический хоррор",
        description: "Дезориентирующий ужас перед непознаваемыми силами и хрупкостью привычного мира.",
        guidance: "Противопоставляй обычное человеческое восприятие явлениям, слишком огромным или чуждым для полного понимания. Предпочитай точные аномалии и незавершённые закономерности исчерпывающим объяснениям. Сохраняй понятную точку зрения, не придумывай новую космологию и не изменяй заданные сущности и события.",
        traits: {
          traits_version: 1,
          tone: ["жуткий", "потрясённый", "фаталистический"],
          rhythm: ["сдержанные фразы, ломающиеся при откровении"],
          pacing: ["ускоряющееся раскрытие"],
          vocabulary: ["точная", "остраняющая", "скупая"],
          dramatic_intensity: "подавляющая"
        },
        positive_examples: ["Сигнал повторил её имя, хотя начал путь ещё до того, как её вид научился говорить."]
      }
    }
  },
  {
    id: "psychological-horror",
    content: {
      en: {
        name: "Psychological horror",
        description: "Intimate unease driven by perception, doubt, and loss of control.",
        guidance: "Anchor fear in specific observations, bodily reactions, and contradictions the viewpoint cannot dismiss. Tighten repetition and unreliable perception gradually. Do not diagnose characters, manufacture trauma, or change what the source confirms as real.",
        traits: {
          traits_version: 1,
          tone: ["intimate", "claustrophobic", "uncertain"],
          rhythm: ["recursive with abrupt interruptions"],
          pacing: ["tightening"],
          vocabulary: ["subjective", "tactile", "controlled"],
          dramatic_intensity: "high"
        },
        positive_examples: ["The second cup was warm. She lived alone, and she had not made tea."]
      },
      ru: {
        name: "Психологический хоррор",
        description: "Камерная тревожная проза о сомнениях восприятия и утрате контроля.",
        guidance: "Закрепляй страх в конкретных наблюдениях, телесных реакциях и противоречиях, которые герой не может отбросить. Постепенно усиливай повторы и ненадёжность восприятия. Не ставь персонажам диагнозы, не придумывай травмы и не меняй то, что исходный текст подтверждает как реальность.",
        traits: {
          traits_version: 1,
          tone: ["камерный", "клаустрофобный", "неуверенный"],
          rhythm: ["возвращающийся с резкими перебоями"],
          pacing: ["сжимающийся"],
          vocabulary: ["субъективная", "осязаемая", "контролируемая"],
          dramatic_intensity: "высокая"
        },
        positive_examples: ["Вторая чашка была тёплой. Она жила одна и не заваривала чай."]
      }
    }
  },
  {
    id: "hard-science-fiction",
    content: {
      en: {
        name: "Hard science fiction",
        description: "Technically grounded speculative prose with clear systems and consequences.",
        guidance: "Explain only the mechanisms needed to understand decisions and consequences. Use consistent terminology, concrete constraints, and observable evidence. Keep exposition attached to action, never invent capabilities, and preserve every authored quantity, rule, and system state.",
        traits: {
          traits_version: 1,
          tone: ["analytical", "credible", "focused"],
          rhythm: ["clear procedural beats"],
          pacing: ["deliberate"],
          vocabulary: ["technical", "economical", "specific"],
          dramatic_intensity: "controlled"
        },
        positive_examples: ["At twelve minutes of oxygen, the detour was no longer a route; it was a calculation with one answer."]
      },
      ru: {
        name: "Твёрдая научная фантастика",
        description: "Технически обоснованная фантастика с ясными системами и последствиями.",
        guidance: "Объясняй только те механизмы, которые нужны для понимания решений и последствий. Используй последовательную терминологию, конкретные ограничения и наблюдаемые свидетельства. Связывай экспозицию с действием, не придумывай новые возможности и сохраняй все авторские числа, правила и состояния систем.",
        traits: {
          traits_version: 1,
          tone: ["аналитический", "достоверный", "сосредоточенный"],
          rhythm: ["ясные процедурные шаги"],
          pacing: ["обдуманный"],
          vocabulary: ["техническая", "экономная", "конкретная"],
          dramatic_intensity: "контролируемая"
        },
        positive_examples: ["При двенадцати минутах кислорода обход перестал быть маршрутом и стал расчётом с единственным ответом."]
      }
    }
  },
  {
    id: "space-opera",
    content: {
      en: {
        name: "Space opera",
        description: "Expansive, energetic science fiction for bold conflict and sweeping adventure.",
        guidance: "Emphasize decisive characters, legible stakes, striking scale, and forward momentum. Use vivid but economical spectacle and let technology serve character choices. Preserve political alignments, world rules, names, and causal outcomes from the source.",
        traits: {
          traits_version: 1,
          tone: ["adventurous", "confident", "expansive"],
          rhythm: ["driving cinematic beats"],
          pacing: ["fast"],
          vocabulary: ["vivid", "heroic", "accessible"],
          dramatic_intensity: "high"
        },
        positive_examples: ["The fleet ignited above the moon, a chain of white fire aimed straight at the blockade."]
      },
      ru: {
        name: "Космическая опера",
        description: "Масштабная энергичная фантастика для ярких конфликтов и больших приключений.",
        guidance: "Подчёркивай решительных персонажей, понятные ставки, впечатляющий масштаб и движение вперёд. Создавай зрелище ярко, но экономно, а технологии подчиняй выбору героев. Сохраняй политические союзы, правила мира, имена и причинные результаты исходника.",
        traits: {
          traits_version: 1,
          tone: ["приключенческий", "уверенный", "масштабный"],
          rhythm: ["стремительные кинематографические фразы"],
          pacing: ["быстрый"],
          vocabulary: ["яркая", "героическая", "доступная"],
          dramatic_intensity: "высокая"
        },
        positive_examples: ["Флот вспыхнул над луной цепью белого огня, нацеленной прямо на блокаду."]
      }
    }
  },
  {
    id: "epic-fantasy",
    content: {
      en: {
        name: "Epic fantasy",
        description: "Elevated, vivid fantasy prose for consequential journeys and legendary conflict.",
        guidance: "Give choices a sense of history and consequence while keeping immediate action clear. Use resonant images and formal cadence selectively rather than archaic filler. Preserve all lore, magic rules, titles, allegiances, and causal facts.",
        traits: {
          traits_version: 1,
          tone: ["elevated", "earnest", "wondrous"],
          rhythm: ["broad cadence with decisive beats"],
          pacing: ["measured adventure"],
          vocabulary: ["mythic", "vivid", "clear"],
          dramatic_intensity: "grand"
        },
        positive_examples: ["When the last beacon answered, seven valleys carried its fire toward the mountain throne."]
      },
      ru: {
        name: "Эпическое фэнтези",
        description: "Возвышенная яркая проза для судьбоносных путешествий и легендарных конфликтов.",
        guidance: "Придавай решениям исторический вес и последствия, сохраняя ясность текущего действия. Используй выразительные образы и торжественный ритм выборочно, без лишней архаики. Не изменяй знания о мире, правила магии, титулы, союзы и причинные факты.",
        traits: {
          traits_version: 1,
          tone: ["возвышенный", "искренний", "чудесный"],
          rhythm: ["широкий ритм с решительными акцентами"],
          pacing: ["размеренное приключение"],
          vocabulary: ["мифическая", "яркая", "ясная"],
          dramatic_intensity: "грандиозная"
        },
        positive_examples: ["Когда ответил последний маяк, семь долин понесли его огонь к горному трону."]
      }
    }
  },
  {
    id: "dark-fantasy",
    content: {
      en: {
        name: "Dark fantasy",
        description: "Harsh, morally uncertain fantasy where wonder carries a visible cost.",
        guidance: "Pair supernatural wonder with physical consequence and difficult choices. Keep violence purposeful rather than indulgent, use concrete images, and allow limited hope to sharpen the darkness. Preserve established magic costs, motives, factions, and outcomes.",
        traits: {
          traits_version: 1,
          tone: ["grim", "haunted", "morally uncertain"],
          rhythm: ["heavy beats broken by sudden action"],
          pacing: ["relentless"],
          vocabulary: ["earthy", "stark", "evocative"],
          dramatic_intensity: "severe"
        },
        positive_examples: ["The healing light closed the wound and left a black vein winding toward his heart."]
      },
      ru: {
        name: "Тёмное фэнтези",
        description: "Суровая неоднозначная проза, в которой у чуда всегда есть видимая цена.",
        guidance: "Соединяй сверхъестественное чудо с физическими последствиями и трудным выбором. Используй насилие по смыслу, а не ради натурализма, выбирай конкретные образы и оставляй ограниченную надежду, чтобы усилить мрак. Сохраняй заданную цену магии, мотивы, фракции и результаты.",
        traits: {
          traits_version: 1,
          tone: ["мрачный", "преследующий", "морально неоднозначный"],
          rhythm: ["тяжёлые фразы, прерываемые внезапным действием"],
          pacing: ["неумолимый"],
          vocabulary: ["приземлённая", "резкая", "образная"],
          dramatic_intensity: "жёсткая"
        },
        positive_examples: ["Целительный свет закрыл рану и оставил чёрную жилу, тянущуюся к сердцу."]
      }
    }
  }
];

/** Returns defensive copies so profile editing cannot mutate the built-in catalog. */
export function stylePresets(locale: StyleContentLocale): StylePreset[] {
  return STYLE_PRESETS.map((preset) => ({
    id: preset.id,
    draft: cloneDraft(preset.content[locale])
  }));
}

export function stylePresetDraft(id: string, locale: StyleContentLocale): StyleProfileDraft | null {
  const preset = STYLE_PRESETS.find((candidate) => candidate.id === id);
  return preset ? cloneDraft(preset.content[locale]) : null;
}

function cloneDraft(draft: StyleProfileDraft): StyleProfileDraft {
  return {
    ...draft,
    traits: {
      ...draft.traits,
      tone: [...draft.traits.tone],
      rhythm: [...draft.traits.rhythm],
      pacing: [...draft.traits.pacing],
      vocabulary: [...draft.traits.vocabulary]
    },
    positive_examples: [...draft.positive_examples]
  };
}
