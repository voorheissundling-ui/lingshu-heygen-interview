/** Automatic product defaults, not a user approval or provider receipt. */
export const WEEKLY_AUTOMATION_TEMPLATE={
 version:'weekly-automation.v3',
 originalVideosPerWeek:5,
 sharedPublicationPlatforms:['youtube','tiktok','instagram','facebook'],
 productionConcurrency:3,
 weekdayOriginalVideosPerDay:1,
 weekendMode:'distribution_and_recovery',
 mondayAction:'weekly_goal_confirmation',
 sundayActions:['weekly_goal_acceptance','weekly_data_review'],
 perFinishedVideoMaxCny:10,
 callToAction:'Contact us on WhatsApp to get your free sample.',
 searchTermCount:5,
 dailyCollectionLimit:10,
 collectionBudgetLimitCny:null,
 ordinaryTaskStart:'06:00',
 residentStart:'00:00',
 residentEnd:'next_day_00:00',
 timeZone:'Asia/Shanghai',
 outboundAuthorization:false,
} as const;
export type WeeklyAutomationTemplate=typeof WEEKLY_AUTOMATION_TEMPLATE;
