import { withQQAccountScope } from '../qq-actions/shared.shared';
import { useEditableSelfProfileFields } from './EditableSelfProfile.shared';
export const EditableSelfProfile = withQQAccountScope(function EditableSelfProfileBody() {
  const { fields, feedback } = useEditableSelfProfileFields();
  return (
    <div className="weq-self-profile-additional">
      {feedback}
      {Object.entries(fields).map(([key, field]) => (
        <div key={key}>{field}</div>
      ))}
    </div>
  );
});
export { RegionEditor } from './EditableSelfProfileEditors';
