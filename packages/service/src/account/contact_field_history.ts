/** 自包含投影器，随历史 worker 序列化执行；只返回实际出现的项目，不把缺字段当作清空。 */
export function projectContactHistoryFields(
  category: string,
  value: unknown,
  memberUid = '',
  groupCode = '',
): Array<[string, unknown]> {
  const name = category.split('.').at(-1) ?? category;
  const memberCategory =
    /^(members|listUserGroups|listMembersInGroup|listLeftMembersInGroup|listMembersByLevel|searchMembersInGroup|getMemberInfo|getMembersByUids|getMembersByUins|listAnalysisMembers|listExportMembers)$/.test(
      name,
    );
  const personCategory =
    /^(getProfile|getBuddy|getBotProfile|exactProfile|nickname|profilesByUids|listProfiles|listBuddies|listFriendsByIntimacy|listExportFriends|editableSelfProfile|details|getFriendRemark|commonRelationships|friendClue|personalityLabels|educationHistory|getQqLevel|getLikeCount|getPeerStats|energy|getFriendMutualMark|getQqShow|fetchShow|getFriendDress|getSelfDress|anonymousQuestions|getOnlineStatus|fetchOnlineStatus)$/.test(
      name,
    );
  if (memberUid ? !memberCategory : !personCategory && !category.startsWith('metric.')) return [];
  // 无关的大名单和照片正文不解压，按批索引只投影当前对象实际需要的资料。
  if (typeof value === 'function') value = value();
  const entries: Array<[string, unknown]> = [];
  const object = (input: unknown): Record<string, unknown> =>
    input && typeof input === 'object' && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  const add = (field: string, input: unknown) => {
    if (input === undefined || object(input).$type === 'undefined') return;
    if (entries.some(([key]) => key === field)) return;
    entries.push([field, input]);
  };
  const row = object(value);
  const fieldMap: Record<string, string> = {
    nick: 'nick',
    nickname: 'nick',
    remark: 'remark',
    signature: 'signature',
    gender: 'gender',
    age: 'age',
    qid: 'qid',
    avatarUrl: 'avatar',
    intimacy: 'intimacy',
    isFriend: 'relationship',
    categoryId: 'category',
  };
  const ext = object(row.extInfo);
  const stableList = (input: unknown, keys: string[]) =>
    Array.isArray(input)
      ? input
          .map((item) => {
            if (!item || typeof item !== 'object') return item;
            const data = object(item);
            return Object.fromEntries(
              keys.filter((key) => data[key] !== undefined).map((key) => [key, data[key]]),
            );
          })
          .sort((a, b) => {
            const left = String(JSON.stringify(a));
            const right = String(JSON.stringify(b));
            return left < right ? -1 : left > right ? 1 : 0;
          })
      : input;
  if (category.startsWith('metric.')) {
    const metricValue = Object.hasOwn(row, 'value') ? row.value : value;
    if (metricValue === null || metricValue === undefined) return [];
    const metric = category.slice(7);
    add(
      (
        {
          likeCount: 'likes',
          schools: 'school',
          addedAt: 'addedAt',
          direction: 'direction',
          sourceGroup: 'sourceGroup',
        } as Record<string, string>
      )[metric] ?? metric,
      metricValue,
    );
    return entries;
  }
  if (memberUid) {
    const candidates = Array.isArray(value)
      ? value
      : Array.isArray(row.members)
        ? row.members
        : [row];
    const member = candidates
      .map(object)
      .find(
        (item) =>
          item.uid === memberUid &&
          (name !== 'listUserGroups' ||
            String(object(item.groupCode).value ?? item.groupCode) === groupCode),
      );
    if (!member) return [];
    for (const [source, field] of Object.entries({
      card: 'card',
      customTitle: 'customTitle',
      adminFlag: 'role',
      memberLevel: 'groupLevel',
      joinTime: 'joinedAt',
      lastSpeakTime: 'lastSpeakAt',
      muteUntil: 'muteUntil',
    }))
      add(field, member[source]);
    return entries;
  }
  if (
    /^(getProfile|getBuddy|getBotProfile|exactProfile|nickname|profilesByUids|listProfiles|listBuddies|listFriendsByIntimacy|listExportFriends|editableSelfProfile)$/.test(
      name,
    )
  ) {
    for (const [source, field] of Object.entries(fieldMap)) add(field, row[source]);
    if (['birthYear', 'birthMonth', 'birthDay'].some((key) => Object.hasOwn(row, key)))
      add(
        'birthday',
        Object.fromEntries(
          ['birthYear', 'birthMonth', 'birthDay']
            .filter((key) => Object.hasOwn(row, key))
            .map((key) => [key, row[key]]),
        ),
      );
    if (['country', 'province', 'city'].some((key) => Object.hasOwn(ext, key)))
      add(
        'region',
        Object.fromEntries(
          ['country', 'province', 'city']
            .filter((key) => Object.hasOwn(ext, key))
            .map((key) => [key, ext[key]]),
        ),
      );
    for (const field of ['occupation', 'school', 'bloodType', 'zodiac', 'company', 'email'])
      add(field, ext[field]);
    add('labels', stableList(ext.interests, ['id', 'text']));
    add('photos', stableList(ext.album, ['photoId']));
    add('privileges', stableList(ext.privileges, ['bizId', 'opened', 'level']));
    add('marks', ext.interactMarks);
    add('relations', row.extRelation);
  }
  if (name === 'details') {
    for (const [source, field] of Object.entries({
      company: 'company',
      email: 'email',
      personalDescription: 'description',
    })) {
      if (!object(row.errors)[source] && row[source] !== null) add(field, row[source]);
    }
  }
  if (name === 'getFriendRemark') add('remark', typeof value === 'string' ? value : row.remark);
  if (name === 'commonRelationships') {
    if (row.friendCount !== null) add('commonFriends', row.friendCount);
    if (Array.isArray(row.groups))
      add('commonGroups', stableList(row.groups, ['groupCode', 'name']));
  }
  if (name === 'friendClue')
    for (const field of ['addedAt', 'direction', 'source', 'sourceGroup'])
      add(field, row[field === 'sourceGroup' ? 'sourceGroupCode' : field]);
  if (name === 'personalityLabels') add('labels', stableList(row.labels, ['id', 'text']));
  if (name === 'educationHistory') add('school', row.items);
  if (name === 'getQqLevel' && value !== null) add('level', value);
  if (name === 'getLikeCount' && value !== null) add('likes', value);
  if (name === 'getPeerStats') {
    if (row.level !== null) add('level', row.level);
    if (row.likeCount !== null) add('likes', row.likeCount);
  }
  if (name === 'energy' && row.score !== null) add('energy', row.score);
  if (name === 'getFriendMutualMark') add('marks', value);
  if (name === 'getQqShow' || name === 'fetchShow') {
    if (Object.hasOwn(row, 'url')) add('qqShow', row.hasShow === false ? null : row.url);
  }
  if (name === 'getFriendDress' || name === 'getSelfDress') add('dress', value);
  if (name === 'anonymousQuestions') add('questions', row.items);
  if (name === 'getOnlineStatus') add('status', row.displayStatus);
  if (
    name === 'fetchOnlineStatus' &&
    ['type', 'subType', 'customStatus'].some((key) => Object.hasOwn(row, key))
  )
    add(
      'status',
      Object.fromEntries(
        ['type', 'subType', 'customStatus']
          .filter((key) => Object.hasOwn(row, key))
          .map((key) => [key, row[key]]),
      ),
    );
  return entries;
}
